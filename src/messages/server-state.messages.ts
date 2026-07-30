import { assertNever } from '@/lib/type-guards'
import { def, t, type TString } from '@/models/messages.models'
import type * as SS from '@/models/server-state.models'

// What moved the queue, named for whoever was not the one who moved it. Systems get a sentence of their own;
// a person gets their name in front of what they did.
export const stateUpdateSource = def((source: SS.LQStateUpdate['source']) => {
	const systemLabels: Record<Extract<SS.LQStateUpdate['source'], { type: 'system' }>['event'], TString> = {
		'server-roll': t('Server rolled to next layer'),
		'app-startup': t('App startup'),
		'vote-timeout': t('Vote timed out'),
		'vote-abort': t('Vote aborted'),
		'vote-cleared': t('Vote cleared'),
		'next-layer-override': t('Next layer overridden'),
		'vote-start': t('Vote started'),
		'admin-change-layer': t('Admin changed layer'),
		'filter-delete': t('Filter deleted'),
		'next-layer-generated': t('Next layer generated'),
		'updates-to-squad-server-toggled': t('Updates to Squad server toggled'),
		'ingame-vote-detected': t('In-game vote detected, SLM updates disabled'),
		'ended-early': t('Vote ended early'),
		'teamswap-execution-completed': t('Teamswaps Executed'),
		'teamswaps-saved': t('Teamswaps Saved'),
		'backburner-updated': t('Layer requests updated'),
	}

	const manualLabels: Record<Extract<SS.LQStateUpdate['source'], { type: 'manual' }>['event'], TString> = {
		'edit-queue': t('saved changes to the queue'),
		'edit-settings': t('edited the queue settings'),
	}

	const text =
		source.type === 'system'
			? systemLabels[source.event]
			: t('{displayName} {did}', { displayName: source.user.displayName, did: manualLabels[source.event] })

	return { text, toast: [text] }
})

export const fogOff = def(() => ({
	broadcast: t('Fog of War is disabled. All points are visible. Check your maps.'),
}))

export const slmUpdatesSet = def((enabled: boolean, ingameVotingTurnedOff?: boolean) => ({
	warn: t(
		'Updates from SLM have been {enabled, select, yes {enabled} other {disabled}}.{turnedOff, select, yes { In-game voting has been turned off, so it no longer decides the next layer.} other {}}',
		{ enabled: enabled ? 'yes' : 'no', turnedOff: ingameVotingTurnedOff ? 'yes' : 'no' },
	),
}))

export const slmUpdatesStatus = def((enabled: boolean, disabledByIngameVote?: boolean) => ({
	warn: t(
		'Updates from SLM are {enabled, select, yes {enabled} other {disabled}}.{byVote, select, yes { An in-game vote is deciding the next layer. Enabling SLM updates will also turn in-game voting off.} other {}}',
		{ enabled: enabled ? 'yes' : 'no', byVote: disabledByIngameVote ? 'yes' : 'no' },
	),
}))

export const slmStarted = def((restartedBy?: string) => ({
	warn: t('{known, select, yes {SLM has been restarted by {restartedBy}.} other {SLM has been started.}}', {
		restartedBy,
		known: restartedBy ? 'yes' : 'no',
	}),
}))

export const ingameVoteDisabledUpdates = def((inferred?: boolean) => ({
	warn: t(
		'{inferred, select, yes {The server no longer has a next layer set, which most likely means in-game voting was enabled.} other {An in-game vote is running.}} The vote decides the next layer, so updates from SLM have been disabled to stop it fighting the vote. Re-enabling them will turn in-game voting off.',
		{ inferred: inferred ? 'yes' : 'no' },
	),
}))

// The server actions an admin can take from the dashboard. Each toast.promise leg is a bare value rather than
// toast args, so these are `text`.
export const disablingFogOfWar = def('Disabling Fog of War...')

export const fogOfWarDisabled = def('Fog of War disabled for current match')

export const disableFogOfWarFailed = def('Failed to disable Fog of War (RCON error)')

export const confirmEndMatch = def((serverName: string) => ({
	confirm: {
		title: t('End Match'),
		description: t('Are you sure you want to end the match for {serverName}?', { serverName }),
		confirmLabel: t('End Match'),
	},
}))

export const endingMatch = def('Ending match on {serverName}...', (serverName: string) => ({ serverName }))

export const matchEnded = def('Match ended!')

export const serverActions = def('Server Actions')

export const endMatchLabel = def('End Match')

export const endMatchNeedsPlayers = def('(disabled: Cannot end match when server is empty.)')

export const enableIngameVoting = def('Enable In-Game Voting')

export const reenableSlmUpdates = def('Re-enable SLM Updates')

export const disableSlmUpdates = def('Disable SLM Updates')

export const disableFogOfWar = def('Disable Fog Of War')

export const serverConsole = def('Server Console')

export const sandboxControls = def('Sandbox Controls')

export const rconUnreachable = def('Unable To connect to RCON server')

// Why a server the user navigated to has no dashboard. `starting` is a waiting state and says so; the other three
// are settled conditions with a repair for each.
export type UnavailableStatus = 'not-found' | 'disabled' | 'broken'

export const unavailableTitle = def((status: UnavailableStatus, displayName: string) => {
	switch (status) {
		case 'not-found':
			return t('Server "{displayName}" Not Found', { displayName })
		case 'disabled':
			return t('Server "{displayName}" Disabled', { displayName })
		case 'broken':
			return t('Server "{displayName}" Has Invalid Settings', { displayName })
		default:
			assertNever(status)
	}
})

export const unavailableDescriptions: Record<UnavailableStatus, TString> = {
	'not-found': t('This server may have been removed from the configuration, or the server ID is incorrect.'),
	disabled: t("This server is disabled, so it isn't running. If you have access, you can enable it on the settings page."),
	broken: t("This server's settings failed validation, so it can't be started. Repair them on the settings page, then enable the server."),
}

export const unavailableHeading = def('What happened?')

export const otherServersHeading = def('Available servers:')

export const backToServersList = def('Go Back to Servers List')

export const startingTitle = def('Starting "{displayName}"', (displayName: string) => ({ displayName }))

export const startingBlurb = def('Waiting for the server to come online. This page will switch to the dashboard on its own.')

export const startingSlowTitle = def('This is taking longer than expected')

export const startingSlowBlurb = def(
	"The server still hasn't come online. It may have failed to start, in which case the logs will say why.",
)
