import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import type { ModelRequest, ModelTurn } from '../../src/agent/model/model-adapter.js'
import { createProductionPersonalMemoryRuntimeV1 } from '../../src/runtime/production-personal-memory-runtime.js'
import type { PostReplyMemoryCandidatePortV1 } from '../../src/runtime/ProductionShadowMemory.js'

type Input = Parameters<PostReplyMemoryCandidatePortV1['enqueue']>[0]
let sequence = 0
function input (prompt: string, overrides: Partial<Input> = {}): Input {
  const id = ++sequence
  return {
    event: { isPrivate: true, isGroup: false, self_id: '10001', user_id: '20002',
      message_id: `shadow-${id}`, sender: { user_id: '20002', nickname: '测试用户' } } as unknown as Input['event'],
    prepared: {
      route: { schemaVersion: 1, requestKind: 'ordinary_chat', profile: 'ordinary',
        presentationIntent: { schemaVersion: 1, kind: 'ordinary', forcePicture: false }, actorId: '20002',
        sessionAddress: { botId: '10001', scope: { kind: 'private', userId: '20002' } } },
      evidence: { schemaVersion: 1, prompt, imageUrls: [], currentMessageId: `shadow-${id}`,
        quotedMessageId: null, hasReply: false, replyResolved: true,
        currentSegmentCount: 1, replySegmentCount: 0, ocrTexts: [] }
    },
    envelope: { kind: 'completed', runRef: id.toString(16).padStart(32, '0'), completion: { kind: 'reply_text', text: '了解了。' } } as Input['envelope'],
    presentation: { schemaVersion: 1, outcome: 'complete', deliveries: [
      { kind: 'sent', media: 'text', attempt: 1, receipt: { schemaVersion: 1, media: 'text' } }
    ] } as unknown as Input['presentation'],
    ...overrides
  }
}

function turn (text: string): ModelTurn {
  return { text, finishReason: 'stop', toolCalls: [], usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } }
}

async function setup (t: TestContext, mode: 'explicit' | 'shadow' | 'automatic' | (() => 'explicit' | 'shadow' | 'automatic') = 'shadow',
  complete?: (request: ModelRequest, signal: AbortSignal) => Promise<ModelTurn>, bot?: unknown) {
  const directory = mkdtempSync(path.join(tmpdir(), 'groupmate-shadow-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const requests: ModelRequest[] = []
  const usage: unknown[] = []
  const admissions: unknown[] = []
  const runtime = await createProductionPersonalMemoryRuntimeV1({
    botInstanceId: 'groupmate-production', storageDirectory: directory,
    deploymentMode: () => typeof mode === 'function' ? mode() : mode, groupAllowlist: () => ['30003'],
    recallMaxItems: () => 6, recallMaxTokens: () => 1_200, recallTimeoutMs: () => 150,
    candidateBot: () => bot,
    candidateAdmission: value => admissions.push(value),
    candidateModel: { model: () => 'test-model', onUsage: value => usage.push(value), adapter: {
      complete: async (request, signal) => {
        requests.push(request)
        if (complete !== undefined) return await complete(request, signal)
        const body = JSON.parse(request.messages[1]!.content!) as { currentMessage: string }
        return turn(JSON.stringify({ candidates: [{ kind: 'preference', text: body.currentMessage,
          confidence: 0.9, sensitivity: 'personal' }] }))
      }
    } }
  })
  t.after(async () => await runtime.close())
  const send = async (text: string, userId = '20002') => {
    const replies: string[] = []
    await runtime.commands.handle({ event: { isPrivate: true, isGroup: false, self_id: '10001', user_id: userId,
      message_id: `command-${++sequence}`, sender: { user_id: userId, nickname: '测试用户' } }, text,
      replyText: async value => { replies.push(value) }, sendPrivateFile: async () => undefined })
    return replies.join('\n')
  }
  const db = new DatabaseSync(path.join(directory, 'personal-memory.sqlite'), { readOnly: true })
  t.after(() => db.close())
  return { directory, runtime, send, db, requests, usage, admissions }
}

test('shadow production stores a sourced pending proposal, records separate usage and never recalls it', async t => {
  const { directory, runtime, send, db, requests, usage } = await setup(t)
  assert.equal(existsSync(path.join(directory, 'personal-memory-extraction.sqlite')), false)
  assert.match(await send('#长期记忆 开启'), /已开启/)
  const request = input('我喜欢喝不加糖的红茶')
  await runtime.postReplyCandidate!.enqueue(request)
  await runtime.waitForCandidateIdle!()
  assert.equal(requests.length, 1)
  assert.equal(usage.length, 1)
  assert.deepEqual(requests[0]!.tools, [])
  assert.equal(requests[0]!.toolMode, 'disabled')
  assert.equal(requests[0]!.reasoning.enabled, false)
  assert.doesNotMatch(JSON.stringify(requests[0]), /20002|了解了/)
  const row = db.prepare('SELECT state, proposal_wire FROM proposals').get()!
  assert.equal(row.state, 'pending')
  const proposal = JSON.parse(String(row.proposal_wire))
  assert.equal(proposal.text, '我喜欢喝不加糖的红茶')
  assert.equal(proposal.sources[0].messageId, request.prepared.evidence.currentMessageId)
  assert.equal(proposal.sources[0].actor.userId, '20002')
  assert.equal(proposal.consentRequirement, 'explicit')
  await runtime.postReplyCandidate!.enqueue(input('我喜欢喝不加糖的红茶'))
  await runtime.waitForCandidateIdle!()
  await runtime.postReplyCandidate!.enqueue(input('我喜欢喝不加糖的红茶。'))
  await runtime.waitForCandidateIdle!()
  assert.equal(db.prepare('SELECT count(*) AS n FROM proposals').get()?.n, 1)
  assert.equal(db.prepare('SELECT count(*) AS n FROM heads').get()?.n, 0)
  assert.match(await send('#长期记忆 列表'), /还没有保存/)
  const status = await runtime.operations.inspect() as Record<string, any>
  assert.equal(status.extraction.status, 'idle')
  assert.equal(status.extraction.pendingRecords, 0)
  assert.equal(statSync(path.join(directory, 'personal-memory-extraction.sqlite')).mode & 0o777, 0o600)
})

test('admission failures report only a bounded stage/outcome and leave ordinary replies alone', async t => {
  const { runtime, send, requests, admissions } = await setup(t)
  await send('#长期记忆 开启')
  const request = input('我喜欢红茶')
  await runtime.postReplyCandidate!.enqueue({ ...request, event: { ...request.event,
    isGroup: true, group_id: '30003', bot: { sendApi: async () => { throw new Error('private host details') } }
  } as unknown as Input['event'] })
  assert.deepEqual(admissions, [{ stage: 'participant', outcome: 'rejected' }])
  assert.equal(requests.length, 0)
  await runtime.postReplyCandidate!.enqueue(input('password=secret123'))
  assert.deepEqual(admissions.at(-1), { stage: 'evidence', outcome: 'rejected' })
  await runtime.postReplyCandidate!.enqueue(input('我喜欢红茶'))
  await runtime.waitForCandidateIdle!()
  assert.deepEqual(admissions.at(-1), { stage: 'queue', outcome: 'accepted' })
})

test('kernel run refs become namespaced memory provenance; invalid refs never reach the queue', async t => {
  const { runtime, send, directory, admissions } = await setup(t, 'shadow', async (_request, signal) =>
    await new Promise<ModelTurn>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
  await send('#长期记忆 开启')
  const request = input('我喜欢红茶')
  await runtime.postReplyCandidate!.enqueue({ ...request, envelope: { ...request.envelope, runRef: 'unavailable' } })
  assert.deepEqual(admissions, [{ stage: 'job', outcome: 'rejected' }])
  const queuePath = path.join(directory, 'personal-memory-extraction.sqlite')
  assert.equal(existsSync(queuePath), false)
  await runtime.postReplyCandidate!.enqueue(request)
  const queue = new DatabaseSync(queuePath, { readOnly: true })
  try {
    const columns = queue.prepare('SELECT job_wire FROM memory_extraction_jobs').get()!
    assert.equal(JSON.parse(String(columns.job_wire)).sourceRunRef, `run:${request.envelope.runRef}`)
  } finally { queue.close(); await runtime.close() }
})

test('group candidates recheck live membership after extraction and reject users who left', async t => {
  let memberPresent = true
  const bot = { sendApi: async (_action: string, value: { user_id: string | number }) => {
    if (String(value.user_id) === '20002' && !memberPresent) return null
    return { user_id: value.user_id, nickname: '测试用户', join_time: 1_700_000_000, role: 'member' }
  } }
  const { runtime, send, db, requests } = await setup(t, 'shadow', async request => {
    memberPresent = false
    const body = JSON.parse(request.messages[1]!.content!) as { currentMessage: string }
    return turn(JSON.stringify({ candidates: [{ kind: 'preference', text: body.currentMessage,
      confidence: 0.9, sensitivity: 'personal' }] }))
  }, bot)
  await send('#长期记忆 开启')
  const group = input('我喜欢喝红茶')
  const event = { ...group.event, isGroup: true, group_id: '30003', bot } as unknown as Input['event']
  await runtime.postReplyCandidate!.enqueue({ ...group, event, prepared: { ...group.prepared,
    route: { ...group.prepared.route,
      sessionAddress: { botId: '10001', scope: { kind: 'group_user', groupId: '30003', userId: '20002' } } }
  } })
  await runtime.waitForCandidateIdle!()
  assert.equal(requests.length, 1)
  assert.equal(db.prepare('SELECT count(*) AS n FROM proposals').get()?.n, 0)
})

test('shutdown cancels a pending provider and leaves a durable job for event-driven restart recovery', async t => {
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const { directory, runtime, send, db } = await setup(t, 'shadow', async (_request, signal) => {
    entered()
    return await new Promise<ModelTurn>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })
  })
  await send('#长期记忆 开启')
  await runtime.postReplyCandidate!.enqueue(input('我喜欢喝红茶'))
  await started
  await runtime.close()
  const queue = new DatabaseSync(path.join(directory, 'personal-memory-extraction.sqlite'))
  try {
    assert.equal(queue.prepare('SELECT count(*) AS n FROM memory_extraction_jobs').get()?.n, 1)
    queue.prepare('UPDATE memory_extraction_jobs SET lease_owner_id = NULL, lease_token = NULL, leased_until_ms = NULL').run()
  } finally { queue.close() }
  let calls = 0
  const reopened = await createProductionPersonalMemoryRuntimeV1({
    botInstanceId: 'groupmate-production', storageDirectory: directory,
    deploymentMode: () => 'shadow', groupAllowlist: () => [],
    recallMaxItems: () => 6, recallMaxTokens: () => 1200, recallTimeoutMs: () => 150,
    candidateModel: { model: () => 'test-model', adapter: { complete: async () => {
      calls += 1
      return turn(JSON.stringify({ candidates: [{ kind: 'preference', text: '我喜欢喝红茶',
        confidence: 0.9, sensitivity: 'personal' }] }))
    } } }
  })
  t.after(async () => await reopened.close())
  await reopened.waitForCandidateIdle!()
  assert.equal(calls, 1)
  assert.equal(db.prepare("SELECT count(*) AS n FROM proposals WHERE state = 'pending'").get()?.n, 1)
})

test('explicit and opted-out sessions do not create queues or make candidate requests', async t => {
  for (const mode of ['explicit', 'shadow'] as const) {
    const { directory, runtime, send, requests } = await setup(t, mode)
    if (mode !== 'shadow') await send('#长期记忆 开启')
    await runtime.postReplyCandidate!.enqueue(input('我喜欢喝红茶'))
    await runtime.waitForCandidateIdle!()
    assert.equal(requests.length, 0)
    assert.equal(existsSync(path.join(directory, 'personal-memory-extraction.sqlite')), false)
  }
})

test('model sensitivity labels cannot authorize health, financial, hypothetical or third-party assertions', async t => {
  const samples = ['我得了糖尿病', '我的工资是三万元', '我的朋友喜欢喝绿茶',
    '我如果是虚构角色会喜欢咖啡', 'I would prefer coffee if I were a fictional character', '我今天很开心']
  for (const text of samples) {
    const { runtime, send, db } = await setup(t, 'automatic', async () => turn(JSON.stringify({ candidates: [
      { kind: 'profile_fact', text, confidence: 1, sensitivity: 'personal' }
    ] })))
    await send('#长期记忆 开启')
    await runtime.postReplyCandidate!.enqueue(input(text))
    await runtime.waitForCandidateIdle!()
    assert.equal(db.prepare('SELECT count(*) AS n FROM proposals').get()?.n, 0)
    assert.equal(db.prepare('SELECT count(*) AS n FROM heads').get()?.n, 0)
  }
})

test('an ungrounded excerpt is a final no-op and does not retain a retryable job body', async t => {
  const { runtime, send, directory, requests, db } = await setup(t, 'shadow', async () =>
    turn(JSON.stringify({ candidates: [{ kind: 'preference', text: '我喜欢红茶',
      confidence: 0.9, sensitivity: 'personal' }] })))
  await send('#长期记忆 开启')
  await runtime.postReplyCandidate!.enqueue(input('我喜欢红茶和绿茶'))
  await runtime.waitForCandidateIdle!()
  assert.equal(requests.length, 1)
  assert.equal(db.prepare('SELECT count(*) AS n FROM proposals').get()?.n, 0)
  const queue = new DatabaseSync(path.join(directory, 'personal-memory-extraction.sqlite'), { readOnly: true })
  try {
    assert.equal(queue.prepare('SELECT count(*) AS n FROM memory_extraction_jobs').get()?.n, 0)
    assert.equal(queue.prepare("SELECT count(*) AS n FROM memory_candidate_audits WHERE outcome = 'no_op'").get()?.n, 1)
  } finally { queue.close() }
})

test('sentence boundaries accept exact punctuation without accepting an abbreviated partial fact', async t => {
  const { runtime, send, db } = await setup(t, 'shadow', async request => {
    const current = JSON.parse(request.messages[1]!.content!).currentMessage as string
    const text = current.startsWith('我') ? '我更喜欢没有糖的柠檬水。' :
      current.startsWith('My') ? 'My native language is English.' : 'I use TypeScript v1.'
    return turn(JSON.stringify({ candidates: [{ kind: 'preference', text,
      confidence: 0.9, sensitivity: 'personal' }] }))
  })
  await send('#长期记忆 开启')
  for (const text of ['我更喜欢没有糖的柠檬水。测试结束。',
    'My native language is English. Trial ended.', 'I use TypeScript v1.2 every day']) {
    await runtime.postReplyCandidate!.enqueue(input(text))
    await runtime.waitForCandidateIdle!()
  }
  const proposals = db.prepare('SELECT proposal_wire FROM proposals').all()
    .map(row => JSON.parse(String(row.proposal_wire)).text).sort()
  assert.deepEqual(proposals, ['My native language is English.', '我更喜欢没有糖的柠檬水。'].sort())
  assert.equal(db.prepare('SELECT count(*) AS n FROM heads').get()?.n, 0)
})

test('automatic production defaults to participation, approves a sourced distinct fact and updates lexical recall', async t => {
  const { directory, runtime, send, db, requests } = await setup(t, 'automatic')
  const request = input('我喜欢喝薄荷茶')
  await runtime.postReplyCandidate!.enqueue(request)
  await runtime.waitForCandidateIdle!()
  assert.equal(requests.length, 1)
  const proposal = JSON.parse(String(db.prepare('SELECT proposal_wire FROM proposals').get()!.proposal_wire))
  assert.equal(proposal.state, 'approved')
  assert.equal(proposal.consentRequirement, 'owner_policy')
  assert.match(proposal.consentPolicyRef, /^policy:[a-f0-9]{64}$/)
  assert.equal(proposal.sources[0].messageId, request.prepared.evidence.currentMessageId)
  assert.equal(db.prepare('SELECT count(*) AS n FROM heads').get()?.n, 1)
  assert.match(await send('#长期记忆 列表'), /薄荷茶/)
  const lexical = new DatabaseSync(path.join(directory, 'personal-memory-lexical.sqlite'), { readOnly: true })
  try { assert.equal(lexical.prepare('SELECT count(*) AS n FROM lexical_documents').get()?.n, 1) }
  finally { lexical.close() }
  await runtime.postReplyCandidate!.enqueue(input('我喜欢喝薄荷茶'))
  await runtime.waitForCandidateIdle!()
  assert.equal(db.prepare('SELECT count(*) AS n FROM heads').get()?.n, 1)
})

test('manual opt-out before the first ordinary message persists and defeats automatic defaults across restart', async t => {
  const { directory, runtime, send, db, requests } = await setup(t, 'automatic')
  assert.match(await send('#长期记忆 关闭'), /已关闭/)
  await runtime.postReplyCandidate!.enqueue(input('我喜欢薄荷茶'))
  await runtime.waitForCandidateIdle!()
  assert.equal(requests.length, 0)
  assert.equal(db.prepare("SELECT state FROM personal_memory_policies").get()?.state, 'opted_out')
  await runtime.close()
  let calls = 0
  const reopened = await createProductionPersonalMemoryRuntimeV1({
    botInstanceId: 'groupmate-production', storageDirectory: directory,
    deploymentMode: () => 'automatic', groupAllowlist: () => [],
    recallMaxItems: () => 6, recallMaxTokens: () => 1200, recallTimeoutMs: () => 150,
    candidateModel: { model: () => 'test-model', adapter: { complete: async () => {
      calls += 1
      return turn('{"candidates":[]}')
    } } }
  })
  t.after(async () => await reopened.close())
  await reopened.postReplyCandidate!.enqueue(input('我喜欢薄荷茶'))
  await reopened.waitForCandidateIdle!()
  assert.equal(calls, 0)
  assert.equal(db.prepare('SELECT count(*) AS n FROM heads').get()?.n, 0)
})

test('automatic defaults upgrade a previous explicit enrollment but preserve an explicit opt-out', async t => {
  let mode: 'explicit' | 'automatic' = 'explicit'
  const { runtime, send, requests, db } = await setup(t, () => mode)
  await send('#长期记忆 开启')
  mode = 'automatic'
  await runtime.postReplyCandidate!.enqueue(input('我喜欢薄荷茶'))
  await runtime.waitForCandidateIdle!()
  assert.equal(requests.length, 1)
  assert.equal(db.prepare('SELECT count(*) AS n FROM heads').get()?.n, 1)
  assert.match(await send('#长期记忆 关闭'), /已关闭/)
  mode = 'explicit'
  mode = 'automatic'
  await runtime.postReplyCandidate!.enqueue(input('我喜欢绿茶'))
  await runtime.waitForCandidateIdle!()
  assert.equal(requests.length, 1)
})

test('automatic low-confidence and conflicting facts remain pending and do not overwrite approved facts', async t => {
  let confidence = 0.9
  const { runtime, send, db } = await setup(t, 'automatic', async request => {
    const body = JSON.parse(request.messages[1]!.content!) as { currentMessage: string }
    return turn(JSON.stringify({ candidates: [{ kind: 'preference', text: body.currentMessage,
      confidence, sensitivity: 'personal' }] }))
  })
  await send('#长期记忆 开启')
  confidence = 0.7
  await runtime.postReplyCandidate!.enqueue(input('我喜欢喝白茶'))
  await runtime.waitForCandidateIdle!()
  assert.equal(db.prepare('SELECT count(*) AS n FROM heads').get()?.n, 0)
  assert.equal(db.prepare("SELECT count(*) AS n FROM proposals WHERE state = 'pending'").get()?.n, 1)
  confidence = 0.9
  // An old shadow proposal cannot be implicitly upgraded by a later automatic job.
  await runtime.postReplyCandidate!.enqueue(input('我喜欢喝白茶'))
  await runtime.waitForCandidateIdle!()
  assert.equal(db.prepare('SELECT count(*) AS n FROM heads').get()?.n, 0)
  await send('#长期记忆 记住 我喜欢喝红茶')
  await runtime.postReplyCandidate!.enqueue(input('我喜欢喝绿茶'))
  await runtime.waitForCandidateIdle!()
  const pending = db.prepare("SELECT proposal_wire FROM proposals WHERE state = 'pending'").all()
    .map(row => JSON.parse(String(row.proposal_wire)))
  assert.equal(pending.find(p => p.text.includes('绿茶')).conflict.state, 'possible')
  assert.equal(db.prepare('SELECT count(*) AS n FROM heads').get()?.n, 1)
})

test('an in-flight automatic extraction cannot approve after deployment mode is narrowed', async t => {
  let mode: 'shadow' | 'automatic' = 'automatic'
  const { runtime, send, db } = await setup(t, () => mode, async request => {
    mode = 'shadow'
    const body = JSON.parse(request.messages[1]!.content!) as { currentMessage: string }
    return turn(JSON.stringify({ candidates: [{ kind: 'preference', text: body.currentMessage,
      confidence: 0.9, sensitivity: 'personal' }] }))
  })
  await send('#长期记忆 开启')
  await runtime.postReplyCandidate!.enqueue(input('我喜欢薄荷茶'))
  await runtime.waitForCandidateIdle!()
  assert.equal(db.prepare('SELECT count(*) AS n FROM heads').get()?.n, 0)
})

test('unknown delivery, secrets, quoted/media evidence and oversized input are rejected before persistence/network', async t => {
  const { directory, runtime, send, requests } = await setup(t)
  await send('#长期记忆 开启')
  const unknown = input('我喜欢红茶', { presentation: { schemaVersion: 1, outcome: 'unknown', deliveries: [
    { kind: 'outcome_unknown', media: 'text', attempt: 1, code: 'unknown_host_result' }
  ] } })
  const quoted = input('我喜欢红茶')
  const media = input('我喜欢红茶')
  for (const request of [unknown, input('我的密码是 hunter2'), input('我'.repeat(600)),
    { ...quoted, prepared: { ...quoted.prepared, evidence: { ...quoted.prepared.evidence, hasReply: true } } },
    { ...media, prepared: { ...media.prepared, evidence: { ...media.prepared.evidence, ocrTexts: ['我喜欢红茶'] } } }]) {
    await runtime.postReplyCandidate!.enqueue(request)
  }
  await runtime.waitForCandidateIdle!()
  assert.equal(requests.length, 0)
  assert.equal(existsSync(path.join(directory, 'personal-memory-extraction.sqlite')), false)
})

test('an existing approved identical fact is deduplicated and changed facts stay conflicted pending candidates', async t => {
  const { runtime, send, db } = await setup(t)
  await send('#长期记忆 开启')
  await send('#长期记忆 记住 我喜欢喝红茶')
  await runtime.postReplyCandidate!.enqueue(input('我喜欢喝红茶'))
  await runtime.waitForCandidateIdle!()
  await runtime.postReplyCandidate!.enqueue(input('我喜欢喝红茶。'))
  await runtime.waitForCandidateIdle!()
  assert.equal(db.prepare('SELECT count(*) AS n FROM proposals').get()?.n, 1)
  await runtime.postReplyCandidate!.enqueue(input('我喜欢喝绿茶'))
  await runtime.waitForCandidateIdle!()
  const row = db.prepare("SELECT proposal_wire FROM proposals WHERE state = 'pending'").get()!
  assert.equal(JSON.parse(String(row.proposal_wire)).conflict.state, 'possible')
  assert.equal(db.prepare('SELECT count(*) AS n FROM heads').get()?.n, 1)
})

test('namespace deletion during extraction prevents late proposals, clears queued bodies and preserves another user', async t => {
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const { directory, runtime, send, db } = await setup(t, 'shadow', async (_request, signal) => {
    entered()
    return await new Promise<ModelTurn>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })
  })
  await send('#长期记忆 开启')
  await send('#长期记忆 开启', '40004')
  await send('#长期记忆 记住 必须保留的另一用户记录', '40004')
  await runtime.postReplyCandidate!.enqueue(input('我喜欢喝红茶'))
  await started
  assert.match(await send('#长期记忆 删除全部 确认'), /已全部删除/)
  await runtime.waitForCandidateIdle!()
  assert.equal(db.prepare('SELECT count(*) AS n FROM heads').get()?.n, 1)
  assert.equal(db.prepare('SELECT count(*) AS n FROM proposals').get()?.n, 1)
  const queue = new DatabaseSync(path.join(directory, 'personal-memory-extraction.sqlite'), { readOnly: true })
  try { assert.equal(queue.prepare('SELECT count(*) AS n FROM memory_extraction_jobs').get()?.n, 0) }
  finally { queue.close() }
  assert.match(await send('#长期记忆 列表', '40004'), /必须保留/)
})

test('opting out while the model is running aborts the job and rejects late admission', async t => {
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const { runtime, send, db } = await setup(t, 'shadow', async (_request, signal) => {
    entered()
    return await new Promise<ModelTurn>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })
  })
  await send('#长期记忆 开启')
  await runtime.postReplyCandidate!.enqueue(input('我喜欢喝红茶'))
  await started
  assert.match(await send('#长期记忆 关闭'), /已关闭/)
  await runtime.waitForCandidateIdle!()
  assert.equal(db.prepare('SELECT count(*) AS n FROM proposals').get()?.n, 0)
})

test('model invented facts, authority fields and sensitive candidates cannot create proposals', async t => {
  for (const output of [
    { candidates: [{ kind: 'preference', text: '我喜欢蓝色', confidence: 0.9, sensitivity: 'personal' }] },
    { candidates: [], approval: 'approved' },
    { candidates: [{ kind: 'profile_fact', text: '我有健康隐私', confidence: 0.9, sensitivity: 'sensitive' }] }
  ]) {
    const { runtime, send, db } = await setup(t, 'shadow', async () => turn(JSON.stringify(output)))
    await send('#长期记忆 开启')
    await runtime.postReplyCandidate!.enqueue(input('我有健康隐私'))
    await runtime.waitForCandidateIdle!()
    assert.equal(db.prepare('SELECT count(*) AS n FROM proposals').get()?.n, 0)
  }
})

test('natural-language third-party quotations are not assigned to the current speaker', async t => {
  const { runtime, send, db } = await setup(t, 'shadow', async () => turn(JSON.stringify({
    candidates: [{ kind: 'preference', text: '我喜欢红茶', confidence: 0.9, sensitivity: 'personal' }]
  })))
  await send('#长期记忆 开启')
  await runtime.postReplyCandidate!.enqueue(input('我的朋友说：“我喜欢红茶”。'))
  await runtime.waitForCandidateIdle!()
  assert.equal(db.prepare('SELECT count(*) AS n FROM proposals').get()?.n, 0)
})
