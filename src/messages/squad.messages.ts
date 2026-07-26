import type * as Msgs from '@/messages/shared'

export const WARNS = {
	// a supplied reason is already the fully-rendered verbatim message; only the no-reason case gets a default
	notifyKilled: (reason?: string) => reason || 'You have been killed by an admin.',
} satisfies Msgs.WarnNode
