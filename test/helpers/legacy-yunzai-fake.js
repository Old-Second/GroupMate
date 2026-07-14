const MAX_CALL_RECORDS = 32

function record (records, value) {
  if (records.length < MAX_CALL_RECORDS) records.push(value)
}

export function createLegacyYunzaiFake ({
  isGroup = true,
  message = 'fixture message',
  sourceMessageId = null,
  senderRole = 'owner'
} = {}) {
  const calls = {
    replies: [],
    groupRecalls: [],
    friendRecalls: [],
    schedules: [],
    handler: [],
    redis: [],
    images: [],
    logs: []
  }

  const group = {
    group_id: 'fixture-group',
    recallMsg (messageId) {
      record(calls.groupRecalls, messageId)
      return Promise.resolve()
    }
  }
  const friend = {
    user_id: 'fixture-friend',
    recallMsg (messageId) {
      record(calls.friendRecalls, messageId)
      return Promise.resolve()
    }
  }
  const handler = {
    async call (name, event, data) {
      record(calls.handler, {
        name,
        eventId: event.event_id,
        data
      })
      return [{ text: 'fixture button' }]
    }
  }
  const event = {
    event_id: 'fixture-event',
    message_id: 'fixture-message',
    group_id: 'fixture-group',
    isGroup,
    message,
    raw_message: message,
    msg: message,
    source: sourceMessageId === null
      ? undefined
      : { message_id: sourceMessageId, seq: sourceMessageId },
    sender: { user_id: 'fixture-user', role: senderRole },
    group: isGroup ? group : undefined,
    friend,
    runtime: { handler },
    async reply (message, quote, data) {
      record(calls.replies, { message, quote, data })
      return { message_id: 'fixture-bot-message' }
    }
  }
  const bot = {
    uin: 'fixture-bot',
    nickname: 'fixture-bot-name'
  }
  const redis = {
    async get (...args) {
      record(calls.redis, { method: 'get', args })
    },
    async set (...args) {
      record(calls.redis, { method: 'set', args })
    },
    async del (...args) {
      record(calls.redis, { method: 'del', args })
    },
    async keys (...args) {
      record(calls.redis, { method: 'keys', args })
      return []
    }
  }
  const segment = {
    image (file) {
      record(calls.images, file)
      return { type: 'image', file }
    }
  }
  const logger = Object.fromEntries(
    ['debug', 'error', 'info', 'mark', 'warn'].map(level => [level, (...args) => {
      record(calls.logs, { level, args })
    }])
  )
  const plugin = {
    id: 'fixture-plugin',
    e: event,
    reply: event.reply.bind(event),
    schedule (callback, delay) {
      record(calls.schedules, { callback, delay })
    }
  }

  return { calls, event, bot, redis, segment, logger, handler, plugin }
}
