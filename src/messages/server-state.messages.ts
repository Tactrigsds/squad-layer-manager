import { assertNever } from '@/lib/type-guards'
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

export const ingameVoteDisabledUpdates = Msgs.def((inferred?: boolean) => ({
	warn: () =>
		(inferred
			? 'The server no longer has a next layer set, which most likely means in-game voting was enabled. '
			: 'An in-game vote is running. ') +
		'The vote decides the next layer, so updates from SLM have been disabled to stop it fighting the vote. ' +
		'Re-enabling them will turn in-game voting off.',
}))

// The server actions an admin can take from the dashboard. Each toast.promise leg is a bare value rather than
// toast args, so these are `text`.
export const disablingFogOfWar = Msgs.def(() => ({ text: () => 'Disabling Fog of War...' }))

export const fogOfWarDisabled = Msgs.def(() => ({ text: () => 'Fog of War disabled for current match' }))

export const disableFogOfWarFailed = Msgs.def(() => ({ text: () => 'Failed to disable Fog of War (RCON error)' }))

export const confirmEndMatch = Msgs.def((serverName: string) => ({
	confirm: () => ({
		title: 'End Match',
		description: `Are you sure you want to end the match for ${serverName}?`,
		confirmLabel: 'End Match',
	}),
}))

export const endingMatch = Msgs.def((serverName: string) => ({ text: () => `Ending match on ${serverName}...` }))

export const matchEnded = Msgs.def(() => ({ text: () => 'Match ended!' }))

export const serverActions = Msgs.def(() => ({ text: () => 'Server Actions' }))

export const endMatchLabel = Msgs.def(() => ({ text: () => 'End Match' }))

export const endMatchNeedsPlayers = Msgs.def(() => ({ text: () => '(disabled: Cannot end match when server is empty.)' }))

export const enableIngameVoting = Msgs.def(() => ({ text: () => 'Enable In-Game Voting' }))

export const reenableSlmUpdates = Msgs.def(() => ({ text: () => 'Re-enable SLM Updates' }))

export const disableSlmUpdates = Msgs.def(() => ({ text: () => 'Disable SLM Updates' }))

export const disableFogOfWar = Msgs.def(() => ({ text: () => 'Disable Fog Of War' }))

export const serverConsole = Msgs.def(() => ({ text: () => 'Server Console' }))

export const sandboxControls = Msgs.def(() => ({ text: () => 'Sandbox Controls' }))

export const rconUnreachable = Msgs.def(() => ({ text: () => 'Unable To connect to RCON server' }))

// Why a server the user navigated to has no dashboard. `starting` is a waiting state and says so; the other three
// are settled conditions with a repair for each.
export type UnavailableStatus = 'not-found' | 'disabled' | 'broken'

export const unavailableTitle = Msgs.def((status: UnavailableStatus, displayName: string) => ({
	text: () => {
		switch (status) {
			case 'not-found':
				return `Server "${displayName}" Not Found`
			case 'disabled':
				return `Server "${displayName}" Disabled`
			case 'broken':
				return `Server "${displayName}" Has Invalid Settings`
			default:
				assertNever(status)
		}
	},
}))

export const unavailableDescriptions: Record<UnavailableStatus, string> = {
	'not-found': 'This server may have been removed from the configuration, or the server ID is incorrect.',
	disabled: "This server is disabled, so it isn't running. If you have access, you can enable it on the settings page.",
	broken: "This server's settings failed validation, so it can't be started. Repair them on the settings page, then enable the server.",
}

export const unavailableHeading = Msgs.def(() => ({ text: () => 'What happened?' }))

export const otherServersHeading = Msgs.def(() => ({ text: () => 'Available servers:' }))

export const backToServersList = Msgs.def(() => ({ text: () => 'Go Back to Servers List' }))

export const startingTitle = Msgs.def((displayName: string) => ({ text: () => `Starting "${displayName}"` }))

export const startingBlurb = Msgs.def(() => ({
	text: () => 'Waiting for the server to come online. This page will switch to the dashboard on its own.',
}))

export const startingSlowTitle = Msgs.def(() => ({ text: () => 'This is taking longer than expected' }))

export const startingSlowBlurb = Msgs.def(() => ({
	text: () => "The server still hasn't come online. It may have failed to start, in which case the logs will say why.",
}))
