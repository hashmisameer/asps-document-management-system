import type { ReactNode } from 'react'
import clsx from 'clsx'
import {
  DEADLINE_STATE,
  DOCUMENT_STATUS,
  type DeadlineState,
  type DocumentStatus,
} from '@asps-dms/shared'

type Tone = 'neutral' | 'pending' | 'uploaded' | 'review' | 'verified' | 'rejected' | 'overdue'

const TONES: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-700',
  pending: 'bg-amber-50 text-status-pending',
  uploaded: 'bg-brand-50 text-status-uploaded',
  review: 'bg-violet-50 text-status-review',
  verified: 'bg-green-50 text-status-verified',
  rejected: 'bg-red-50 text-status-rejected',
  overdue: 'bg-red-50 text-status-overdue',
}

/**
 * A small status label.
 *
 * Colour is never the only carrier of meaning: every badge says what it means
 * in words as well, so it stays readable in greyscale and to anyone who cannot
 * distinguish the two reds.
 */
export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        TONES[tone],
      )}
    >
      {children}
    </span>
  )
}

export const DOCUMENT_STATUS_TONE: Readonly<Record<DocumentStatus, Tone>> = {
  [DOCUMENT_STATUS.PENDING]: 'pending',
  [DOCUMENT_STATUS.UPLOADED]: 'uploaded',
  [DOCUMENT_STATUS.UNDER_REVIEW]: 'review',
  [DOCUMENT_STATUS.VERIFIED]: 'verified',
  [DOCUMENT_STATUS.REJECTED]: 'rejected',
}

export const DEADLINE_STATE_TONE: Readonly<Record<DeadlineState, Tone>> = {
  [DEADLINE_STATE.NOT_APPLICABLE]: 'neutral',
  [DEADLINE_STATE.COMPLETED]: 'verified',
  [DEADLINE_STATE.NOT_DUE]: 'neutral',
  [DEADLINE_STATE.DUE_SOON]: 'pending',
  [DEADLINE_STATE.DUE_TODAY]: 'pending',
  [DEADLINE_STATE.OVERDUE]: 'overdue',
}
