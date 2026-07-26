import * as Msgs from '@/messages/shared'

// a supplied reason is already the fully-rendered verbatim message; only the no-reason case gets a default
export const notifyKilled = Msgs.def((reason?: string) => ({
	warn: () => reason || 'You have been killed by an admin.',
}))
