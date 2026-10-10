import type { RunContentJournalEvent } from '../../agent/run/run-content-journal.js'
import type { PolicyNetworkDiagnostic } from '../tools/policy-fetch.js'
import type { YunzaiAgentRequestDraft } from '../yunzai-request-adapter.js'
import {
  projectOutboundJournalEvent,
  type GroupMateOutboundJournalEvent
} from './content-journal-outbound-projector.js'
import type { ProjectedJournalEvent } from './content-journal-projection.js'
import {
  projectRequestJournalEvent,
  projectRunJournalEvent
} from './content-journal-request-run-projector.js'
import type {
  GroupMateDiskLog,
  GroupMateDiskLogEvent
} from './groupmate-disk-log.js'

export type { GroupMateOutboundJournalEvent } from './content-journal-outbound-projector.js'

export interface GroupMateContentJournal {
  recordRequest(request: YunzaiAgentRequestDraft): void
  recordRunEvent(event: RunContentJournalEvent): void
  recordOutbound(event: GroupMateOutboundJournalEvent): void
  recordNetworkDiagnostic?(event: PolicyNetworkDiagnostic): void
  drain(): Promise<void>
}

type DiskLogPort = Pick<GroupMateDiskLog, 'record' | 'drain'>
type ProjectionOperation = 'request' | 'run_event' | 'outbound'

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
        durationMs: event.durationMs, timeoutMs: event.timeoutMs, redirects: event.redirects
      }) }))
    },
    async drain (): Promise<void> {
      try {
        await diskLog.drain()
      } catch {}
    }
  })
}
