import type * as Msgs from '@/messages/shared'

export const BROADCASTS = {
	fogOff: 'Fog of War is disabled. All points are visible. Check your maps.',
} satisfies Msgs.MessageNode

export const WARNS = {
	slmUpdatesSet(enabled: boolean) {
		return `Updates from SLM have been ${enabled ? 'enabled' : 'disabled'}.`
	},
	slmUpdatesStatus(enabled: boolean) {
		return `Updates from SLM are ${enabled ? 'enabled' : 'disabled'}.`
	},
	ingameVoteDisabledUpdates:
		'An in-game next layer vote is running. The vote decides the next layer, so updates from SLM have been disabled to stop it fighting the vote. Re-enable them once voting is turned off.',
	slmStarted: (restartedBy?: string) => (restartedBy ? `SLM has been restarted by ${restartedBy}.` : `SLM has been started.`),
} satisfies Msgs.WarnNode
