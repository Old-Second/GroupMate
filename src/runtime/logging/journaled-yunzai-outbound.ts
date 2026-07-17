import type {
  OutboundDeliveryOptions,
  OutboundPart,
  RuntimeDeliveryReceipt,
  YunzaiOutboundPort,
  YunzaiOutboundPortFactory
} from '../presentation/yunzai-outbound-port.js'
import type { DeliveryResult } from '../presentation/presentation-result.js'
import type { SessionAddress } from '../../agent/contracts/identity.js'
import type {
  GroupMateContentJournal,
  GroupMateOutboundJournalEvent
} from './groupmate-content-journal.js'

type WithoutOccurredAt<T> = T extends unknown ? Omit<T, 'occurredAt'> : never
type OutboundJournalEventDraft = WithoutOccurredAt<GroupMateOutboundJournalEvent>

function recordSafely (
  journal: GroupMateContentJournal,
  now: () => Date,
  event: OutboundJournalEventDraft
): void {
  try {
    journal.recordOutbound(Object.freeze({
      ...event,
      occurredAt: now().toISOString()
    }) as GroupMateOutboundJournalEvent)
  } catch {}
}

function journaledPort (
  delegate: YunzaiOutboundPort,
  journal: GroupMateContentJournal,
  now: () => Date
): YunzaiOutboundPort {
  return Object.freeze({
    target: delegate.target,
    async deliver<P extends OutboundPart> (
      part: P,
      attempt: 1 | 2,
      options?: OutboundDeliveryOptions
    ): Promise<DeliveryResult<P['media']>> {
      const result = await delegate.deliver(part, attempt, options)
      recordSafely(journal, now, {
        type: 'qq.outbound.deliver',
        target: delegate.target,
        part,
        attempt,
        quoteMessageId: options?.quoteMessageId ?? null,
        result
      })
      return result
    },
    async recall (receipt: RuntimeDeliveryReceipt, signal?: AbortSignal) {
      const result = await delegate.recall(receipt, signal)
      recordSafely(journal, now, {
        type: 'qq.outbound.recall',
        target: delegate.target,
        receipt,
        result
      })
      return result
    }
  })
}

export function createJournaledYunzaiOutboundPortFactory (
  delegate: YunzaiOutboundPortFactory,
  journal: GroupMateContentJournal,
  now: () => Date
): YunzaiOutboundPortFactory {
  return Object.freeze({
    async forTarget (target: SessionAddress) {
      return journaledPort(await delegate.forTarget(target), journal, now)
    }
  })
}
