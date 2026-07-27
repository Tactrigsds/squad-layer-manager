import * as Msgs from '@/messages/shared'

export const fogOff = Msgs.def(() => ({
	broadcast: () => 'Fog of War is disabled. All points are visible. Check your maps.',
}))

export const slmUpdatesSet = Msgs.def((enabled: boolean, ingameVotingTurnedOff?: boolean) => ({
	warn: () =>
		`Updates from SLM have been ${enabled ? 'enabled' : 'disabled'}.` +
		(ingameVotingTurnedOff ? ' In-game voting has been turned off, so it no longer decides the next layer.' : ''),
}))

export const slmUpdatesStatus = Msgs.def((enabled: boolean, disabledByIngameVote?: boolean) => ({
	warn: () =>
		`Updates from SLM are ${enabled ? 'enabled' : 'disabled'}.` +
		(disabledByIngameVote ? ' An in-game vote is deciding the next layer. Enabling SLM updates will also turn in-game voting off.' : ''),
}))

export const slmStarted = Msgs.def((restartedBy?: string) => ({
	warn: () => (restartedBy ? `SLM has been restarted by ${restartedBy}.` : `SLM has been started.`),
}))

export const ingameVoteDisabledUpdates = Msgs.def(() => ({
	warn: () =>
		'An in-game next layer vote is running. The vote decides the next layer, so updates from SLM have been disabled to stop it fighting the vote. Re-enable them once voting is turned off.',
}))
