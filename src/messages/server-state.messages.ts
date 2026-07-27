import * as Msgs from '@/messages/shared'
import type * as SS from '@/models/server-state.models'

// What moved the queue, named for whoever was not the one who moved it. Systems get a sentence of their own;
// a person gets their name in front of what they did.
export const stateUpdateSource = Msgs.def((source: SS.LQStateUpdate['source']) => {
	const systemLabels: Record<Extract<SS.LQStateUpdate['source'], { type: 'system' }>['event'], string> = {
		'server-roll': 'Server rolled to next layer',
		'app-startup': 'App startup',
		'vote-timeout': 'Vote timed out',
		'vote-abort': 'Vote aborted',
		'vote-cleared': 'Vote cleared',
		'next-layer-override': 'Next layer overridden',
		'vote-start': 'Vote started',
		'admin-change-layer': 'Admin changed layer',
		'filter-delete': 'Filter deleted',
		'next-layer-generated': 'Next layer generated',
		'updates-to-squad-server-toggled': 'Updates to Squad server toggled',
		'ingame-vote-detected': 'In-game vote detected, SLM updates disabled',
		'ended-early': 'Vote ended early',
		'teamswap-execution-completed': 'Teamswaps Executed',
		'teamswaps-saved': 'Teamswaps Saved',
		'backburner-updated': 'Layer requests updated',
	}

	const manualLabels: Record<Extract<SS.LQStateUpdate['source'], { type: 'manual' }>['event'], string> = {
		'edit-queue': 'saved changes to the queue',
		'edit-settings': 'edited the queue settings',
	}

	const text = source.type === 'system' ? systemLabels[source.event] : `${source.user.displayName} ${manualLabels[source.event]}`

	return { text: () => text, toast: () => [text] }
})

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
