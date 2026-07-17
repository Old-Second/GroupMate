import type { RunContentJournalEvent } from '../../agent/run/run-content-journal.js'
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
    async drain (): Promise<void> {
      try {
        await diskLog.drain()
      } catch {}
    }
  })
}
