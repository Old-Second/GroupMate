const scenarios = ['node', 'openaiClient', 'idle', 'singleRun', 'twoRun']
const scenario = process.argv[2]

if (!scenarios.includes(scenario)) {
  throw new Error(`Unknown memory scenario: ${scenario || '<missing>'}`)
}

if (typeof globalThis.gc !== 'function') {
  throw new Error('Memory scenarios require Node.js --expose-gc')
}

const observations = []
const retainedReferences = {
  clients: [],
  stores: [],
  results: []
}

let requestCount = 0
let concurrentRequests = 0
let maxConcurrentRequests = 0

function observeRss () {
  const rssBytes = process.memoryUsage().rss
  observations.push(rssBytes)
  return rssBytes
}

function beginRequest () {
  requestCount += 1
  concurrentRequests += 1
  maxConcurrentRequests = Math.max(maxConcurrentRequests, concurrentRequests)
  observeRss()
  return requestCount
}

function endRequest () {
  concurrentRequests -= 1
  if (concurrentRequests < 0) {
    throw new Error('Synthetic request concurrency became negative')
  }
}

function createSyntheticResponse (requestNumber) {
  const body = {
    id: `fixture-response-${requestNumber}`,
    choices: [{
      message: {
        role: 'assistant',
        content: `fixture answer ${requestNumber}`
      }
    }],
    usage: {
      prompt_tokens: 2,
      completion_tokens: 3,
      total_tokens: 5
    }
  }

  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    async json () { return body },
    async text () { return JSON.stringify(body) }
  }
}

function createDeferred () {
  let resolve
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function createClient (ChatGPTAPI, fetch) {
  const client = new ChatGPTAPI({
    apiKey: 'fixture-key',
    apiBaseUrl: 'https://fixture.invalid/v1',
    fetch,
    completionParams: { model: 'fixture-model' },
    systemMessage: 'fixture system',
    maxModelTokens: 8192,
    maxResponseTokens: 4096
  })

  retainedReferences.clients.push(client)
  retainedReferences.stores.push(client._messageStore)
  observeRss()
  return client
}

async function withSuppressedLegacyLog (run) {
  const originalLog = console.log
  console.log = () => {}
  try {
    return await run()
  } finally {
    console.log = originalLog
  }
}

async function runIdle (ChatGPTAPI) {
  createClient(ChatGPTAPI, async () => {
    const requestNumber = beginRequest()
    try {
      return createSyntheticResponse(requestNumber)
    } finally {
      endRequest()
    }
  })
}

async function runSingle (ChatGPTAPI) {
  const client = createClient(ChatGPTAPI, async () => {
    const requestNumber = beginRequest()
    try {
      return createSyntheticResponse(requestNumber)
    } finally {
      endRequest()
    }
  })

  const result = await withSuppressedLegacyLog(() => client.sendMessage(
    'fixture prompt one',
    {
      stream: false,
      conversationId: 'fixture-conversation-one',
      messageId: 'fixture-message-one'
    }
  ))
  retainedReferences.results.push(result)
  observeRss()
}

async function runTwo (ChatGPTAPI) {
  const bothRequestsArrived = createDeferred()
  const releaseRequests = createDeferred()
  const fetch = async () => {
    const requestNumber = beginRequest()
    if (requestCount === 2) {
      bothRequestsArrived.resolve()
    }
    try {
      await releaseRequests.promise
      return createSyntheticResponse(requestNumber)
    } finally {
      endRequest()
    }
  }
  const clients = [
    createClient(ChatGPTAPI, fetch),
    createClient(ChatGPTAPI, fetch)
  ]

  await withSuppressedLegacyLog(async () => {
    const runSettlements = Promise.allSettled([
      clients[0].sendMessage('fixture prompt one', {
        stream: false,
        conversationId: 'fixture-conversation-one',
        messageId: 'fixture-message-one'
      }),
      clients[1].sendMessage('fixture prompt two', {
        stream: false,
        conversationId: 'fixture-conversation-two',
        messageId: 'fixture-message-two'
      })
    ])

    let barrierError
    let barrierTimeout
    try {
      await Promise.race([
        bothRequestsArrived.promise,
        new Promise((resolve, reject) => {
          barrierTimeout = setTimeout(() => {
            reject(new Error('Timed out waiting for two synthetic requests'))
          }, 1000)
        })
      ])
      observeRss()
    } catch (error) {
      barrierError = error
    } finally {
      clearTimeout(barrierTimeout)
      releaseRequests.resolve()
    }

    const settlements = await runSettlements
    if (barrierError) throw barrierError
    const rejectedRun = settlements.find(settlement => settlement.status === 'rejected')
    if (rejectedRun) throw rejectedRun.reason

    retainedReferences.results.push(...settlements.map(settlement => settlement.value))
    observeRss()
  })
}

if (scenario !== 'node') {
  const { ChatGPTAPI } = await import('../utils/openai/chatgpt-api.js')
  observeRss()

  if (scenario === 'idle') await runIdle(ChatGPTAPI)
  if (scenario === 'singleRun') await runSingle(ChatGPTAPI)
  if (scenario === 'twoRun') await runTwo(ChatGPTAPI)
}

globalThis.gc()
await new Promise(resolve => setTimeout(resolve, 25))
const retainedRssBytes = process.memoryUsage().rss
observations.push(retainedRssBytes)

const expectedReferenceCounts = {
  node: [0, 0, 0],
  openaiClient: [0, 0, 0],
  idle: [1, 1, 0],
  singleRun: [1, 1, 1],
  twoRun: [2, 2, 2]
}
const actualReferenceCounts = [
  retainedReferences.clients.length,
  retainedReferences.stores.length,
  retainedReferences.results.length
]
if (actualReferenceCounts.some((count, index) => count !== expectedReferenceCounts[scenario][index])) {
  throw new Error(`Unexpected retained references for ${scenario}: ${actualReferenceCounts.join('/')}`)
}

const expectedRequestCounts = {
  node: 0,
  openaiClient: 0,
  idle: 0,
  singleRun: 1,
  twoRun: 2
}
if (requestCount !== expectedRequestCounts[scenario]) {
  throw new Error(`Unexpected synthetic request count for ${scenario}: ${requestCount}`)
}
if (concurrentRequests !== 0) {
  throw new Error(`Synthetic requests still active for ${scenario}: ${concurrentRequests}`)
}

const rawMaxRss = process.resourceUsage().maxRSS
const maxRssScale = rawMaxRss >= retainedRssBytes ? 1 : 1024
const observedPeakRssBytes = Math.max(...observations, rawMaxRss * maxRssScale)
if (!Number.isInteger(retainedRssBytes) || retainedRssBytes <= 0) {
  throw new Error(`Invalid retained RSS for ${scenario}: ${retainedRssBytes}`)
}
if (!Number.isInteger(observedPeakRssBytes) || observedPeakRssBytes < retainedRssBytes) {
  throw new Error(`Invalid observed peak RSS for ${scenario}: ${observedPeakRssBytes}`)
}

process.stdout.write(JSON.stringify({
  scenario,
  requestCount,
  maxConcurrentRequests,
  retainedRssBytes,
  observedPeakRssBytes,
  maxRssScale
}))
