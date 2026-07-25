import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  createProductionPersonalMemoryRuntimeV1
} from '../../src/runtime/production-personal-memory-runtime.js'

function options (storageDirectory: string) {
  return Object.freeze({
    botInstanceId: 'groupmate-production',
    storageDirectory,
    deploymentMode: () => 'explicit' as const,
    groupAllowlist: () => Object.freeze([]),
    recallMaxItems: () => 6,
    recallMaxTokens: () => 1_200,
    recallTimeoutMs: () => 150
  })
}

function groupEvent (groupId: string, messageId: string) {
  return Object.freeze({
    isGroup: true,
    self_id: '10001',
    user_id: '20002',
    group_id: groupId,
    message_id: messageId,
    sender: Object.freeze({ user_id: '20002', nickname: '用20002', card: '测试成员' }),
    bot: Object.freeze({
      sendApi: async (_action: string, input: { user_id: string | number }) => Object.freeze({
        user_id: input.user_id,
        nickname: input.user_id === 10001 ? 'GroupMate' : '用20002',
        role: 'member',
        join_time: 1_700_000_000
      })
    })
  })
}

async function recallPrivate (
  runtime: Awaited<ReturnType<typeof createProductionPersonalMemoryRuntimeV1>>,
  text: string,
  sequence: number
): Promise<Record<string, any>> {
  return await runtime.recallSource.recall(Object.freeze({
    request: Object.freeze({
      createdAt: new Date().toISOString(),
      sessionAddress: Object.freeze({ botId: '10001' })
    }),
    event: Object.freeze({
      isGroup: false,
      user_id: '20002',
      sender: Object.freeze({ user_id: '20002', nickname: '用户20002' })
    }),
    messageEvidence: Object.freeze({
      schemaVersion: 1,
      prompt: text,
      imageUrls: Object.freeze([]),
      currentMessageId: `recall-message-${sequence}`,
      quotedMessageId: null,
      hasReply: false,
      replyResolved: false,
      currentSegmentCount: 1,
      replySegmentCount: 0,
      ocrTexts: Object.freeze([])
    }),
    queryText: text
  })) as Record<string, any>
}

test('production personal memory runtime bootstraps, reports and reopens bounded stores', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'groupmate-production-memory-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))

  const first = await createProductionPersonalMemoryRuntimeV1(options(directory))
  assert.equal(existsSync(path.join(directory, 'personal-memory.sqlite')), true)
  assert.equal(existsSync(path.join(directory, 'personal-memory-lexical.sqlite')), true)
  const firstStatus = await first.operations.inspect() as Record<string, any>
  assert.equal(firstStatus.canonical.sqliteFileBytes > 0, true)
  assert.equal(firstStatus.lexical.sqliteFileBytes > 0, true)
  assert.deepEqual({
    ...firstStatus,
    canonical: { ...firstStatus.canonical, sqliteFileBytes: 'nonzero' },
    lexical: { ...firstStatus.lexical, sqliteFileBytes: 'nonzero' }
  }, {
    schemaVersion: 1,
    status: 'ready',
    canonical: {
      namespaces: 0,
      activeRecords: 0,
      logicalBytes: 0,
      sqliteFileBytes: 'nonzero'
    },
    lexical: {
      status: 'ready',
      records: 0,
      logicalBytes: 0,
      sqliteFileBytes: 'nonzero',
      lagRecords: 0
    },
    extraction: {
      status: 'idle',
      pendingRecords: 0,
      deadLetterRecords: 0,
      logicalBytes: 0
    },
    hotCache: { status: 'disabled', records: 0, logicalBytes: 0 },
    semantic: { embedding: 'disabled', vector: 'disabled', rerank: 'disabled' }
  })
  assert.deepEqual(await first.operations.execute({
    schemaVersion: 1,
    action: 'verify'
  }), {
    schemaVersion: 1,
    status: 'completed',
    action: 'verify',
    affectedRecords: 0
  })
  assert.deepEqual(await first.operations.execute({
    schemaVersion: 1,
    action: 'rebuild_lexical'
  }), {
    schemaVersion: 1,
    status: 'completed',
    action: 'rebuild_lexical',
    affectedRecords: 0
  })
  await first.close()
  await first.close()

  const reopened = await createProductionPersonalMemoryRuntimeV1(options(directory))
  const status = await reopened.operations.inspect() as {
    canonical: { sqliteFileBytes: number }
    lexical: { sqliteFileBytes: number }
  }
  assert.equal(status.canonical.sqliteFileBytes > 0, true)
  assert.equal(status.lexical.sqliteFileBytes > 0, true)
  await reopened.close()
})

test('production personal memory commands complete the private QQ lifecycle and keep lexical state current', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'groupmate-production-memory-command-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const runtime = await createProductionPersonalMemoryRuntimeV1(options(directory))
  t.after(async () => await runtime.close())
  let sequence = 0
  let exported = ''

  const send = async (text: string, userId = '20002'): Promise<string> => {
    const replies: string[] = []
    sequence += 1
    const handled = await runtime.commands.handle(Object.freeze({
      event: Object.freeze({
        isGroup: false,
        isPrivate: true,
        self_id: '10001',
        user_id: userId,
        message_id: `private-message-${sequence}`,
        sender: Object.freeze({ user_id: userId, nickname: `用户${userId}` })
      }),
      text,
      replyText: async (value: string) => { replies.push(value) },
      sendPrivateFile: async (filePath: string) => {
        exported = readFileSync(filePath, 'utf8')
      }
    }))
    assert.equal(handled, true)
    assert.equal(replies.length, 1, JSON.stringify(replies))
    return replies[0]!
  }

  assert.match(await send('#长期记忆 状态'), /未开启/)
  assert.match(await send('#长期记忆 开启'), /已开启/)
  assert.match(await send('#长期记忆 记住 我喜欢低因无糖咖啡'), /已记住/)

  let status = await runtime.operations.inspect() as Record<string, any>
  assert.equal(status.canonical.activeRecords, 1)
  assert.equal(status.lexical.records, 1)
  assert.equal(status.lexical.status, 'ready')

  const firstList = await send('#长期记忆 列表')
  assert.match(firstList, /我喜欢低因无糖咖啡/)
  const reference = /(@[0-9a-f]{8})/.exec(firstList)?.[1]
  assert.notEqual(reference, undefined)
  assert.match(
    await send(`#长期记忆 更正 ${reference} 我喜欢低因低糖咖啡`),
    /已更正/
  )
  assert.match(await send(`#长期记忆 续期 ${reference} 30`), /已续期至/)
  assert.match(await send('#长期记忆 导出'), /已导出/)
  assert.match(exported, /"type":"record_revision"/)
  assert.match(exported, /我喜欢低因低糖咖啡/)

  assert.match(await send('#长期记忆 关闭'), /已关闭/)
  assert.match(await send('#长期记忆 状态'), /已关闭/)
  assert.match(await send('#长期记忆 开启'), /已开启/)
  assert.match(await send(`#长期记忆 遗忘 ${reference}`), /已遗忘/)
  status = await runtime.operations.inspect() as Record<string, any>
  assert.equal(status.canonical.activeRecords, 0)
  assert.equal(status.lexical.records, 0)

  assert.match(await send('#长期记忆 记住 我的常用编辑器是 VS Code'), /已记住/)
  const beforeDeleteRecall = await recallPrivate(runtime, '我的常用编辑器', sequence)
  assert.equal(beforeDeleteRecall.status, 'completed')
  assert.deepEqual(beforeDeleteRecall.candidates.map((candidate: any) => candidate.text), [
    '我的常用编辑器是 VS Code'
  ])
  assert.match(await send('#长期记忆 删除全部'), /确认/)
  status = await runtime.operations.inspect() as Record<string, any>
  assert.equal(status.canonical.activeRecords, 1)
  assert.equal(status.lexical.records, 1)
  assert.match(await send('#长期记忆 删除全部 确认'), /已全部删除/)
  status = await runtime.operations.inspect() as Record<string, any>
  assert.equal(status.canonical.activeRecords, 0)
  assert.equal(status.lexical.records, 0)
  assert.equal(status.lexical.status, 'ready')
  assert.deepEqual(await recallPrivate(runtime, '我的常用编辑器', sequence), {
    schemaVersion: 2,
    status: 'unavailable',
    reason: 'not_opted_in'
  })

  assert.match(await send('#长期记忆 列表', '30003'), /还没有保存/)
  await runtime.close()

  const reopened = await createProductionPersonalMemoryRuntimeV1(options(directory))
  const reopenedReplies: string[] = []
  await reopened.commands.handle(Object.freeze({
    event: Object.freeze({
      isGroup: false,
      self_id: '10001',
      user_id: '20002',
      message_id: 'private-message-reopened',
      sender: Object.freeze({ user_id: '20002', nickname: '用户20002' })
    }),
    text: '#长期记忆 状态',
    replyText: async (value: string) => { reopenedReplies.push(value) },
    sendPrivateFile: async () => undefined
  }))
  assert.equal(reopenedReplies.length, 1)
  assert.match(reopenedReplies[0]!, /未开启/)
  const reopenedStatus = await reopened.operations.inspect() as Record<string, any>
  assert.equal(reopenedStatus.canonical.activeRecords, 0)
  assert.equal(reopenedStatus.lexical.records, 0)
  const reopenedCommandReplies: string[] = []
  await reopened.commands.handle(Object.freeze({
    event: Object.freeze({
      isGroup: false,
      isPrivate: true,
      self_id: '10001',
      user_id: '20002',
      message_id: 'private-message-reopened-enable',
      sender: Object.freeze({ user_id: '20002', nickname: '用户20002' })
    }),
    text: '#长期记忆 开启',
    replyText: async (value: string) => { reopenedCommandReplies.push(value) },
    sendPrivateFile: async () => undefined
  }))
  assert.equal(reopenedCommandReplies.length, 1)
  assert.match(reopenedCommandReplies[0]!, /已开启/)
  const reopenedRecall = await recallPrivate(reopened, '我的常用编辑器', sequence)
  assert.equal(reopenedRecall.status, 'completed')
  assert.deepEqual(reopenedRecall.candidates, [])
  await reopened.close()
})

test('production personal memory commands fail closed outside the group allowlist and after mode is disabled', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'groupmate-production-memory-policy-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  let mode: 'off' | 'explicit' = 'explicit'
  const runtime = await createProductionPersonalMemoryRuntimeV1(Object.freeze({
    ...options(directory),
    deploymentMode: () => mode,
    groupAllowlist: () => Object.freeze(['40004'])
  }))
  t.after(async () => await runtime.close())

  const send = async (event: unknown, text: string): Promise<string> => {
    const replies: string[] = []
    await runtime.commands.handle(Object.freeze({
      event,
      text,
      replyText: async (value: string) => { replies.push(value) },
      sendPrivateFile: async () => undefined
    }))
    assert.equal(replies.length, 1)
    return replies[0]!
  }

  assert.match(
    await send(groupEvent('50005', 'group-denied'), '#长期记忆 开启'),
    /当前群未加入/
  )
  assert.match(
    await send(groupEvent('40004', 'group-allowed'), '#长期记忆 开启'),
    /已开启/
  )
  mode = 'off'
  assert.match(
    await send(groupEvent('40004', 'group-mode-off'), '#长期记忆 记住 不应写入'),
    /当前未启用/
  )
  const status = await runtime.operations.inspect() as Record<string, any>
  assert.equal(status.canonical.activeRecords, 0)
})

test('production personal memory command replay is idempotent and failed export removes delivery files', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'groupmate-production-memory-replay-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const runtime = await createProductionPersonalMemoryRuntimeV1(options(directory))
  t.after(async () => await runtime.close())

  const send = async (
    text: string,
    messageId: string,
    sendPrivateFile: (filePath: string, fileName: string) => Promise<void> = async () => undefined
  ): Promise<string> => {
    const replies: string[] = []
    await runtime.commands.handle(Object.freeze({
      event: Object.freeze({
        isGroup: false,
        self_id: '10001',
        user_id: '20002',
        message_id: messageId,
        sender: Object.freeze({ user_id: '20002', nickname: '用20002' })
      }),
      text,
      replyText: async (value: string) => { replies.push(value) },
      sendPrivateFile
    }))
    assert.equal(replies.length, 1)
    return replies[0]!
  }

  await send('#长期记忆 开启', 'enable-replay')
  assert.match(await send('#长期记忆 记住 我的编辑器是 Vim', 'remember-replay'), /已记住/)
  assert.match(
    await send('#长期记忆 记住 我的编辑器是 Vim', 'remember-replay'),
    /已记住|刚刚发生变化/
  )
  const status = await runtime.operations.inspect() as Record<string, any>
  assert.equal(status.canonical.activeRecords, 1)
  assert.match(await send(
    '#长期记忆 导出',
    'export-failure',
    async () => { throw new Error('simulated QQ file failure') }
  ), /发送失败/)
  assert.deepEqual(readdirSync(path.join(directory, 'export-delivery')), [])
})

test('production personal memory commands reject events without a stable QQ message ID', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'groupmate-production-memory-message-id-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const runtime = await createProductionPersonalMemoryRuntimeV1(options(directory))
  t.after(async () => await runtime.close())
  const replies: string[] = []

  await runtime.commands.handle(Object.freeze({
    event: Object.freeze({
      isGroup: false,
      self_id: '10001',
      user_id: '20002',
      sender: Object.freeze({ user_id: '20002', nickname: '用20002' })
    }),
    text: '#长期记忆 记住 不应写入',
    replyText: async (value: string) => { replies.push(value) },
    sendPrivateFile: async () => undefined
  }))

  assert.deepEqual(replies, ['无法确认当前 QQ 消息编号，长期记忆操作未执行。'])
  const status = await runtime.operations.inspect() as Record<string, any>
  assert.equal(status.canonical.namespaces, 0)
  assert.equal(status.canonical.activeRecords, 0)
})
