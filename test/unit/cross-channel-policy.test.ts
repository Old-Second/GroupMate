import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  migrateLegacyCrossChannelPolicies,
  resolveCrossChannelAccess
} from '../../src/runtime/tools/cross-channel-policy.js'

test('legacy cross-channel booleans migrate without removing unknown keys', () => {
  const source = Object.freeze({
    enableToolPrivateSend: true,
    enableToolCrossGroupSend: false,
    unknown: 'keep'
  })
  assert.deepEqual(migrateLegacyCrossChannelPolicies(source), {
    enableToolPrivateSend: true,
    enableToolCrossGroupSend: false,
    toolPrivateSendPolicy: 'master',
    toolCrossGroupSendPolicy: 'disabled',
    unknown: 'keep'
  })
  assert.equal(Object.hasOwn(source, 'toolPrivateSendPolicy'), false)
})

test('new cross-channel fields take precedence over legacy booleans', () => {
  assert.deepEqual(migrateLegacyCrossChannelPolicies({
    toolPrivateSendPolicy: 'everyone',
    toolCrossGroupSendPolicy: 'master',
    enableToolPrivateSend: false,
    enableToolCrossGroupSend: false
  }), {
    toolPrivateSendPolicy: 'everyone',
    toolCrossGroupSendPolicy: 'master',
    enableToolPrivateSend: false,
    enableToolCrossGroupSend: false
  })
})

test('missing cross-channel fields use safe new-install defaults', () => {
  assert.deepEqual(resolveCrossChannelAccess({}), {
    private: 'master',
    group: 'disabled'
  })
})

test('runtime resolution accepts legacy-only configuration', () => {
  assert.deepEqual(resolveCrossChannelAccess({
    enableToolPrivateSend: false,
    enableToolCrossGroupSend: true
  }), {
    private: 'disabled',
    group: 'master'
  })
})

test('invalid present cross-channel fields fail closed without legacy fallback', () => {
  assert.deepEqual(resolveCrossChannelAccess({
    toolPrivateSendPolicy: 'invalid',
    toolCrossGroupSendPolicy: true,
    enableToolPrivateSend: true,
    enableToolCrossGroupSend: true
  }), {
    private: 'disabled',
    group: 'disabled'
  })
})

test('all valid cross-channel policy values resolve independently', () => {
  for (const privatePolicy of ['disabled', 'master', 'everyone'] as const) {
    for (const groupPolicy of ['disabled', 'master', 'everyone'] as const) {
      assert.deepEqual(resolveCrossChannelAccess({
        toolPrivateSendPolicy: privatePolicy,
        toolCrossGroupSendPolicy: groupPolicy
      }), {
        private: privatePolicy,
        group: groupPolicy
      })
    }
  }
})
