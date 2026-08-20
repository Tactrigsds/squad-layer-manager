// see settings.messages.tsx on why a messages module with a react target keeps React in scope
import * as React from 'react'

import type * as CHAT from '@/models/chat.models'
import { def, raw, rt, t, type TString } from '@/models/messages.models'
import type * as TA from '@/models/team-attribution.models'

export const secondaryFilterLabels: Record<CHAT.SecondaryFilterState, TString> = {
	ALL: t('All'),
	DEFAULT: t('Default'),
	CHAT: t('Chat'),
	SLM_EVENTS: t('SLM Events'),
	ADMIN: t('Admin'),
	KILLFEED: t('Killfeed'),
}

// Both chat boxes report a send failure the same way: the result code when the call answered, nothing when it threw.
export const sendFailed = def((code?: string) => ({
	toast: code === undefined ? [t('Failed to send')] : [t('Failed to send'), { description: raw(code) }],
}))

// -------- the activity feed --------

export const activityTitle = def('Server Activity')

export const viewingHistoricalMatch = def('Viewing historical match')

export const noPlayersSelected = def('No players selected. Select players in the teams panel to filter the feed.')

export const noEventsYet = def(
	'No events yet for {match, select, current {current match} other {this match}}',
	(match: 'current' | 'historical') => ({ match }),
)

export const connectionLost = def('Connection lost - attempting to reconnect...')

export const reconnectionFailed = def('Reconnection failed - unable to reconnect to the server. Please refresh the page.')

export const scrollToBottom = def('Scroll to bottom')

export const loadOlderEvents = def('Load older events')

export const noMoreEvents = def('No more events to load')

export const newEvents = def('{count, plural, one {# new event} other {# new events}}', (count: number) => ({ count }))

export const previousMatch = def('Previous match')

export const nextMatch = def('Next match')

export const returnToLive = def('Return to Live')

export const returnToLiveTooltip = def('Return to live events')

// -------- the historical teams view --------

export const feedViewLabel = def('Feed')

export const teamsViewLabel = def('Teams')

export const historicalTeamsTitle = def('Historical teams')

export const historicalTeamsDescription = def(
	'Everyone who played this match, on the team they spent the most time on. Flagged players are not counted in the team breakdown chart.',
)

export const unassignedSquad = def('Unassigned')

export const teamPlayerCount = def('{count, plural, one {# player} other {# players}}', (count: number) => ({ count }))

export const scorelineHint = def('Kills / Wounds / Deaths')

export const timeOnTeam = def('{time} on this team', (time: string) => ({ time }))

export const alsoOnOtherTeam = def('Also played {time} on the other team', (time: string) => ({ time }))

export const notInBreakdown = def('Not counted in the team breakdown:')

export const exclusionReasonLabels: Record<TA.ExclusionReason, TString> = {
	'low-team-time': t('too little time on their team'),
	'split-team-time': t('time split too evenly between teams'),
	'no-squad': t('never joined a squad'),
	'no-combat': t('no kills, deaths or wounds'),
}

export const playersOnline = def('Players online')

export const playersInQueue = def('Players in queue')

export const serverTickRate = def('Server tick rate')

// -------- the chat boxes --------

export const notifyAdmins = def('Notify admins')

export const notifyAdminsHint = def('Warn every online admin that this warn was sent')

export const prefixNameHint = def('Prefix the message with your username')

export const warnAdminsChannel = def('Admins')

export const broadcastChannel = def('Broadcast')

export const warnSelectedChannel = def('Selected{any, select, yes { ({count})} other {}}', (count: number) => ({
	count,
	any: count > 0 ? 'yes' : 'no',
}))

export const sendHint = def('Send (Enter)')

export const sendWarningHint = def('Send warning (Enter)')

export const missingPermission = def('Missing permission')

export const warnAdminsPlaceholder = def('Warn all online admins…')

export const broadcastPlaceholder = def('Broadcast to the server…')

export const nobodySelectedPlaceholder = def('No players selected in the teams panel')

export const warnSelectedPlaceholder = def(
	'Warn {count, plural, one {# selected player} other {# selected players}}…',
	(count: number) => ({ count }),
)

export const noOneToWarnPlaceholder = def('No one to warn')

export const warnPlaceholder = def('Warn…')

export const selectedOnly = def('Selected Only')

// -------- the activity feed's event lines --------
//
// Each event type is one message taking the nodes the feed renders inline (a player, a squad, a team, a layer).
// The whole sentence lives here with its slots named, which is what a locale needs: word order, the connectives
// and the punctuation are all the message's, and only what the slots look like belongs to the caller.

export const chatChannelBroadcast = def('(broadcast)')

export const chatChannelBroadcastHint = def('admin broadcast message')

export const chatChannelAll = def('(all)')

export const chatChannelAllHint = def('this message was sent in all chat')

export const chatChannelAdmin = def('(admin)')

export const chatChannelAdminHint = def('this message was sent in admin chat')

export const broadcastFromRcon = def('RCON')

export const broadcastFromUnknown = def('unknown')

export const playerConnected = def((player: React.ReactNode, team?: React.ReactNode) =>
	rt('{player} connected{hasTeam, select, yes {, joining {team}} other {}}', { player, team, hasTeam: team !== undefined ? 'yes' : 'no' }),
)

export const playerDisconnected = def((player: React.ReactNode) => rt('{player} disconnected', { player }))

export const enteredAdminCamera = def((player: React.ReactNode) => rt('{player} entered admin camera', { player }))

export const exitedAdminCamera = def((player: React.ReactNode) => rt('{player} exited admin camera', { player }))

// the reason is styled down by the caller; the separator that introduces it is part of the sentence
export const playerKicked = def((player: React.ReactNode, reason?: React.ReactNode) =>
	rt('{player} was kicked{hasReason, select, yes { - {reason}} other {}}', {
		player,
		reason,
		hasReason: reason !== undefined ? 'yes' : 'no',
	}),
)

export const squadCreated = def((creator: React.ReactNode, squad: React.ReactNode, team: React.ReactNode) =>
	rt('{creator} created {squad} on {team}', { creator, squad, team }),
)

export const playerBanned = def((player: React.ReactNode, interval: string) =>
	rt('{player} was banned reason: "{interval}"', { player, interval }),
)

export const playerWarned = def((player: React.ReactNode, reason: string) => rt('{player} was warned: "{reason}"', { player, reason }))

export const playersWarned = def((players: React.ReactNode, reason: string) => rt('{players} were warned: "{reason}"', { players, reason }))

export const playerCountWarned = def((count: number, reason: string) =>
	rt('{count, plural, one {# player} other {# players}} were warned: "{reason}"', { count, reason }),
)

export const playerChangedTeam = def((player: React.ReactNode, team: React.ReactNode) => rt('{player} changed to {team}', { player, team }))

export const playerLeftSquad = def((player: React.ReactNode, squad: React.ReactNode, wasLeader: boolean) =>
	rt('{player} left {squad}{wasLeader, select, yes { (was leader)} other {}}', { player, squad, wasLeader: wasLeader ? 'yes' : 'no' }),
)

export const playerJoinedSquad = def((player: React.ReactNode, squad: React.ReactNode) => rt('{player} joined {squad}', { player, squad }))

export const playerPromotedToLeader = def((player: React.ReactNode) => rt('{player} promoted to squad leader', { player }))

export const squadWasDisbanded = def((squad: React.ReactNode) => rt('{squad} was disbanded', { squad }))

export const squadLockChanged = def((squad: React.ReactNode, locked: boolean) =>
	rt('{squad} {locked, select, yes {locked} other {unlocked}}', { squad, locked: locked ? 'yes' : 'no' }),
)

// the new name is emphasised, which is part of the sentence; the feed styles `strong` itself
export const squadRenamed = def((squad: React.ReactNode, newName: string) =>
	rt('{squad} renamed to <strong>"{newName}"</strong>', { squad, newName }),
)

export const playerSuicide = def((victim: React.ReactNode, wounded: boolean, weapon?: React.ReactNode) =>
	rt('{victim} {wounded, select, yes {wounded themselves} other {killed themselves}}{weapon}', {
		victim,
		wounded: wounded ? 'yes' : 'no',
		weapon,
	}),
)

export const playerTeamkilled = def((victim: React.ReactNode, attacker: React.ReactNode, weapon?: React.ReactNode) =>
	rt('{victim} teamkilled by {attacker}{weapon}', { victim, attacker, weapon }),
)

export const playerDowned = def((victim: React.ReactNode, wounded: boolean, attacker: React.ReactNode, weapon?: React.ReactNode) =>
	rt('{victim} {wounded, select, yes {wounded by} other {killed by}} {attacker}{weapon}', {
		victim,
		wounded: wounded ? 'yes' : 'no',
		attacker,
		weapon,
	}),
)

export const withWeapon = def(' with {weapon}', (weapon: string) => ({ weapon }))

// -------- match boundaries --------

export const newGameStarted = def('New game started')

export const newGameOnAppStart = def('New game detected on Application Start')

export const newGameOnRconReconnect = def('New game detected on RCON Reconnect')

export const currentMatch = def('Current Match')

// `{label} ({which}): {layer}` -- which is either "Current Match" or how many matches back this one is
export const newGameLine = def((label: string, which: React.ReactNode, layer: React.ReactNode) =>
	rt('{label} ({which}): {layer}', { label, which, layer }),
)

// the draw readout is coloured on its own rather than by the container, which the winner line also uses
export const draw = def('Draw')

export const roundEndedDraw = def((layer: React.ReactNode, outcome: React.ReactNode) =>
	rt('Round ended ({layer}) {outcome}', { layer, outcome }),
)

// the ticket score is emphasised, which is part of the sentence; the feed styles `strong` itself
export const roundEndedWinner = def(
	(layer: React.ReactNode, winner: React.ReactNode, winnerTickets: number, loserTickets: number, loser: React.ReactNode) =>
		rt('Round ended ({layer}) {winner} won <strong>{winnerTickets} to {loserTickets}</strong> against {loser}', {
			layer,
			winner,
			winnerTickets,
			loserTickets,
			loser,
		}),
)

// how the round was ended, when something ended it rather than the tickets running out
export const roundEndAction = def((action: string, source: React.ReactNode, nextLayer?: React.ReactNode) =>
	rt('({action} {source}{nextLayer})', { action, source, nextLayer }),
)

export const roundEndBy = def((who: React.ReactNode) => rt('by {who}', { who }))

export const roundEndVia = def((tool: React.ReactNode) => rt('via {tool}', { tool }))

export const roundEndSwitchingTo = def((layer: React.ReactNode) => rt(', switching to {layer}', { layer }))

export const rconTool = def('RCON')

export const slmTool = def('SLM')

// -------- the layer the server is about to play --------

export const observedNextLayer = def((layer: React.ReactNode) => rt("Server's next layer is {layer}", { layer }))

export const nextLayerSetBy = def((who: React.ReactNode, layer: React.ReactNode) =>
	rt('{who} set the next layer to {layer}', { who, layer }),
)

export const nextLayerSet = def((layer: React.ReactNode) => rt('Next layer set to {layer}', { layer }))

export const ingameAdmin = def('an in-game admin')

export const anotherRconTool = def('another RCON tool')

// -------- connection and in-game voting --------

export const ingameVoteStarted = def('In-game vote started on the Squad server')

export const ingameVoteChoices = def(' ({choices})', (choices: readonly string[]) => ({ choices: choices.join(', ') }))

export const rconReconnected = def('RCON reconnected')

export const rconFirstConnected = def('Application started, RCON connection established')

export const rconDisconnected = def('RCON disconnected')
