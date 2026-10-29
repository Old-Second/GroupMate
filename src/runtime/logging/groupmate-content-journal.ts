import type { RunContentJournalEvent } from '../../agent/run/run-content-journal.js'
import type { PolicyNetworkDiagnostic } from '../tools/policy-fetch.js'
import { isNetworkPolicyErrorCode } from '../../agent/tools/network-policy.js'
import type { YunzaiAgentRequestDraft } from '../yunzai-request-adapter.js'
import {
  projectOutboundJournalEvent,
  type GroupMateOutboundJournalEvent
} from './content-journal-outbound-projector.js'
import { projectParticipationObservation, type ProjectedJournalEvent } from './content-journal-projection.js'
import type { ParticipationObservation } from '../participation/ParticipationShadow.js'
import type { GreetingQuotaDecision } from '../activities/GreetingQuota.js'
import {
  projectRequestJournalEvent,
  projectRunJournalEvent
} from './content-journal-request-run-projector.js'
import type {
  GroupMateDiskLog,
  GroupMateDiskLogEvent
} from './groupmate-disk-log.js'

export type { GroupMateOutboundJournalEvent } from './content-journal-outbound-projector.js'

export interface GroupMateGreetingQuotaJournalEvent {
  readonly botId: string
  readonly groupId: string
  readonly decision: GreetingQuotaDecision
}

export interface GroupMateContentJournal {
  recordRequest(request: YunzaiAgentRequestDraft): void
  recordRunEvent(event: RunContentJournalEvent): void
  recordOutbound(event: GroupMateOutboundJournalEvent): void
  recordNetworkDiagnostic?(event: PolicyNetworkDiagnostic): void
  recordParticipation?(event: ParticipationObservation): void
  recordGreetingQuota?(event: GroupMateGreetingQuotaJournalEvent): void
  drain(): Promise<void>
}

type DiskLogPort = Pick<GroupMateDiskLog, 'record' | 'drain'>
type ProjectionOperation = 'request' | 'run_event' | 'outbound' | 'participation'

function failureEvent (operation: ProjectionOperation): GroupMateDiskLogEvent {
  return Object.freeze({
    type: 'groupmate.content_journal.projection_failure',
    payload: Object.freeze({ operation, code: 'invalid_content' })
  })
}

export function createGroupMateContentJournal (
  diskLog: DiskLogPort
): GroupMateContentJournal {
  const safeRecordEvent = (event: GroupMateDiskLogEvent): void => {
    try {
      diskLog.record(event)
    } catch {}
  }
  const recordProjection = (
    operation: ProjectionOperation,
    project: () => ProjectedJournalEvent
  ): void => {
    try {
      safeRecordEvent(project())
    } catch {
      safeRecordEvent(failureEvent(operation))
    }
  }
  return Object.freeze({
    recordParticipation (event: ParticipationObservation): void {
      recordProjection('participation', () => projectParticipationObservation(event))
    },

    recordRequest (request: YunzaiAgentRequestDraft): void {
      recordProjection('request', () => projectRequestJournalEvent(request))
    },
    recordRunEvent (event: RunContentJournalEvent): void {
      recordProjection('run_event', () => projectRunJournalEvent(event))
    },
    recordOutbound (event: GroupMateOutboundJournalEvent): void {
      recordProjection('outbound', () => projectOutboundJournalEvent(event))
    },
    recordNetworkDiagnostic (event: PolicyNetworkDiagnostic): void {
      if (!['image_search', 'image_fetch', 'other'].includes(event.tag) ||
        !['dns', 'headers', 'body', 'complete'].includes(event.phase) ||
        !['success', 'failure', 'timeout', 'cancelled'].includes(event.result) ||
        ![event.durationMs, event.timeoutMs, event.redirects].every(value => Number.isSafeInteger(value) && value >= 0)) return
      safeRecordEvent(Object.freeze({ type: 'tool.network', payload: Object.freeze({
        tag: event.tag, phase: event.phase, result: event.result,
        durationMs: event.durationMs, timeoutMs: event.timeoutMs, redirects: event.redirects,
        ...(typeof event.httpStatus === 'number' && Number.isSafeInteger(event.httpStatus) && event.httpStatus >= 100 && event.httpStatus <= 599
          ? { httpStatus: event.httpStatus } : {}),
        ...(isNetworkPolicyErrorCode(event.errorCode) ? { errorCode: event.errorCode } : {})
      }) }))
    },
    recordGreetingQuota (event: GroupMateGreetingQuotaJournalEvent): void {
      const decision = event.decision
      if (!/^[0-9]{1,20}$/.test(event.botId) || !/^[0-9]{1,20}$/.test(event.groupId) ||
        !['allowed', 'rejected'].includes(decision.kind) ||
        ![decision.dailyUsed, decision.dailyLimit, decision.hourlyUsed, decision.hourlyLimit]
          .every(value => Number.isSafeInteger(value) && value >= 0)) return
      safeRecordEvent(Object.freeze({ type: 'greeting.quota', payload: Object.freeze({
        botId: event.botId, groupId: event.groupId, decision: decision.kind,
        dailyUsed: decision.dailyUsed, dailyLimit: decision.dailyLimit,
        hourlyUsed: decision.hourlyUsed, hourlyLimit: decision.hourlyLimit,
        ...(decision.kind === 'rejected' ? { reason: decision.reason } : {})
      }) }))
    },
    async drain (): Promise<void> {
      try {
        await diskLog.drain()
      } catch {}
    }
  })
}
