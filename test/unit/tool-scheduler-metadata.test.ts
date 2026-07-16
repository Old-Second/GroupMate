import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ToolRuntimeFacts } from '../../src/agent/tools/tool-context.js'
import type {
  DeliveryResult,
  OutboundMedia,
  RuntimeDeliveryReceipt
} from '../../src/runtime/presentation/presentation-result.js'
import { resourceKey } from '../../src/agent/tools/resource-key.js'
import { ToolRegistry } from '../../src/agent/tools/tool-registry.js'
import type { PolicyFetch } from '../../src/runtime/tools/policy-fetch.js'
import {
  createManagementToolDefinitions,
  createQueryToolRuntime,
  createVisibleToolDefinitions
} from '../../src/runtime/tools/tool-runtime-factory.js'
import type { QqManagementCapabilities } from '../../src/tools/management-tool-support.js'
import type { ToolResource, VisibleToolServices } from '../../src/tools/visible-tool-support.js'

const facts: ToolRuntimeFacts = {
  botId: '10000',
  actor: { userId: '70001', role: 'owner', isBotMaster: true },
  channel: { kind: 'group', botId: '10000', groupId: '90001' },
  scope: { kind: 'group', groupId: '90001' },
  botGroupRole: 'owner', actorGroupRole: 'owner', targetRole: 'member',
  targetIsBotMaster: false, targetExists: true
}

const resource: ToolResource = Object.freeze({
  kind: 'buffer', data: new Uint8Array(), mimeType: 'image/png', byteLength: 0
})

function sentDelivery<M extends OutboundMedia> (media: M): DeliveryResult<M> {
  return Object.freeze({
    kind: 'sent', media, attempt: 1,
    receipt: Object.freeze({ schemaVersion: 1, media }) as RuntimeDeliveryReceipt<M>
  })
}

function productionDefinitions () {
  const policyFetch = {} as PolicyFetch
  const visibleServices: VisibleToolServices = {
    policyFetch,
    qq: {
      sendText: async () => sentDelivery('text'),
      sendImage: async () => sentDelivery('picture'),
      sendAudio: async () => sentDelivery('voice'),
      sendVideo: async () => sentDelivery('video'),
      sendMusic: async () => sentDelivery('music'),
      sendDice: async () => sentDelivery('dice'),
      sendRps: async () => sentDelivery('rps')
    },
    generateImage: async () => resource,
    processImage: async () => resource,
    synthesizeAudio: async () => resource,
    resolveVideo: async id => ({ id, shareText: id }),
    drawingAvailable: true,
    pictureProcessingAvailable: true,
    ttsAvailable: true,
    videoDownloadEnabled: false,
    videoMaxBytes: 1024,
    crossChannelAccess: { private: 'everyone', group: 'everyone' }
  }
  const management: QqManagementCapabilities = {
    muteMember: async () => {}, kickMember: async () => {}, setCard: async () => {},
    setTitle: async () => {}, recallMessage: async () => {}, setEssence: async () => {}
  }
  const query = createQueryToolRuntime({
    policyFetch,
    config: {
      searchSource: 'public', publicSearchSource: 'bing', tavilyApiKey: '', bingApiKey: '',
      amapKey: '', amapApiBaseUrl: 'https://restapi.amap.com',
      githubApiBaseUrl: 'https://api.github.com', githubApiKey: '',
      imageSearchSource: 'public', braveSearchApiKey: '',
      extraUrl: 'https://caption.example.com'
    },
    currentGroupMembers: async () => new Map(),
    queryGame: async () => resource,
    sendGameImage: async () => {}
  }).definitions
  return Object.freeze([
    ...createVisibleToolDefinitions(visibleServices),
    ...createManagementToolDefinitions(management),
    ...query
  ])
}

const validInputs: Readonly<Record<string, Readonly<Record<string, unknown>>>> = Object.freeze({
  draw: { prompt: 'cat' },
  processPicture: { type: 'hed', imageUrl: 'https://image.example/cat.png', userId: '' },
  sendPicture: { urls: ['https://image.example/cat.png'] },
  sendVideo: { id: 'BV1xx' }, sendAvatar: { userIds: ['70001'] },
  sendMusic: { id: '1' }, sendAudioMessage: { text: 'hello', voice: '' },
  sendDice: { count: 1 }, sendRPS: { value: 1 },
  sendMessage: { text: 'private message body', targetKind: 'group', targetId: '90002' },
  editCard: { userId: '70002', card: 'member' },
  jinyan: { userId: '70002', seconds: 60 }, kickOut: { userId: '70002' },
  setTitle: { userId: '70002', title: 'title' },
  handleMsg: { type: 'recall', messageId: 'message-123' },
  search: { q: 'private search query', num: 3 },
  website: { url: 'https://first.example/private/path?secret=value' },
  weather: { city: 'private city' },
  github: { q: 'private repository', type: 'repositories', num: 3, path: '' },
  queryUserinfo: { userId: '70002' },
  queryGenshin: { userId: '70002', uid: '', character: '' },
  queryStarRail: { userId: '70002', uid: '', character: '' },
  searchImage: { q: 'private image query', limit: 2 },
  searchVideo: { keyword: 'private video query', limit: 2 },
  searchMusic: { keyword: 'private music query', limit: 2 },
  imageCaption: { imageUrl: 'https://image.example/private.png', userId: '', question: 'secret?' }
})

function byName (name: string) {
  const definition = productionDefinitions().find(item => item.name === name)
  assert.ok(definition)
  return definition
}

test('every production tool has explicit bounded scheduling metadata', () => {
  const definitions = productionDefinitions()
  assert.equal(definitions.length, 26)
  for (const definition of definitions) {
    assert.ok(['read_only', 'visible_output', 'side_effect'].includes(definition.executionClass))
    assert.equal(typeof definition.retrySafe, 'boolean')
    const input = validInputs[definition.name]
    assert.ok(input, definition.name)
    const keys = definition.resourceKeys(input, facts)
    assert.equal(Object.isFrozen(keys), true, definition.name)
    assert.ok(keys.length <= 8, definition.name)
    assert.equal(keys.every(key => /^[a-z][a-z0-9_.:-]{0,127}$/.test(key)), true, definition.name)
    if (definition.executionClass !== 'read_only') assert.equal(definition.retrySafe, false, definition.name)
  }
})

test('resource keys serialize current-channel conflicts without exposing sensitive values', () => {
  const currentOutput = byName('sendPicture').resourceKeys(validInputs.sendPicture, facts)
  const memberMutation = byName('editCard').resourceKeys(validInputs.editCard, facts)
  const messageMutation = byName('handleMsg').resourceKeys(validInputs.handleMsg, facts)

  assert.ok(currentOutput.some(key => memberMutation.includes(key)))
  assert.ok(currentOutput.some(key => messageMutation.includes(key)))
  const serialized = JSON.stringify([currentOutput, memberMutation, messageMutation])
  for (const secret of ['90001', '70002', 'message-123']) assert.equal(serialized.includes(secret), false)
})

test('independent read targets produce distinct opaque resource keys', () => {
  const website = byName('website')
  const first = website.resourceKeys({ url: 'https://first.example/private?q=one' }, facts)
  const second = website.resourceKeys({ url: 'https://second.example/private?q=two' }, facts)
  assert.notDeepEqual(first, second)
  const serialized = JSON.stringify([first, second])
  for (const secret of ['first.example', 'second.example', 'private', 'one', 'two']) {
    assert.equal(serialized.includes(secret), false)
  }

  const message = byName('sendMessage').resourceKeys(validInputs.sendMessage, facts)
  assert.equal(JSON.stringify(message).includes('private message body'), false)
  assert.equal(JSON.stringify(message).includes('90002'), false)
})

test('resource key uses a stable bounded digest and snapshot manifest is serializable', () => {
  const first = resourceKey('http', 'https://example.com/private?q=secret')
  const second = resourceKey('http', 'https://example.com/private?q=secret')
  assert.equal(first, second)
  assert.match(first, /^http:[a-f0-9]{24}$/)
  assert.equal(first.includes('example.com'), false)

  const definitions = productionDefinitions()
  const snapshot = new ToolRegistry(definitions).createSnapshot({
    id: 'phase-5', facts, enabledTools: definitions.map(item => item.name)
  })
  assert.deepEqual(snapshot.manifest.map(item => item.name), [...snapshot.toolNames].sort())
  assert.match(snapshot.fingerprint, /^[a-f0-9]{64}$/)
  assert.equal(Object.isFrozen(snapshot.manifest), true)
  assert.doesNotThrow(() => JSON.stringify({
    manifest: snapshot.manifest, fingerprint: snapshot.fingerprint
  }))
  assert.equal(JSON.stringify(snapshot.manifest).includes('resourceKeys'), false)
})
