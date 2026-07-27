// see settings.messages.tsx on why a messages module with a react target keeps React in scope
import * as React from 'react'

import * as Msgs from '@/messages/shared'
import type * as CHAT from '@/models/chat.models'

export const secondaryFilterLabels: Record<CHAT.SecondaryFilterState, string> = {
	ALL: 'All',
	DEFAULT: 'Default',
	CHAT: 'Chat',
	SLM_EVENTS: 'SLM Events',
	ADMIN: 'Admin',
	KILLFEED: 'Killfeed',
}

// Both chat boxes report a send failure the same way: the result code when the call answered, nothing when it threw.
export const sendFailed = Msgs.def((code?: string) => ({
	toast: (): Msgs.ToastArgs => (code === undefined ? ['Failed to send'] : ['Failed to send', { description: code }]),
}))

// -------- the activity feed --------

export const activityTitle = Msgs.def('Server Activity')

export const viewingHistoricalMatch = Msgs.def('Viewing historical match')

export const noPlayersSelected = Msgs.def('No players selected. Select players in the teams panel to filter the feed.')

export const noEventsYet = Msgs.def(
	'No events yet for {match, select, current {current match} other {this match}}',
	(match: 'current' | 'historical') => ({ match }),
)

export const connectionLost = Msgs.def('Connection lost - attempting to reconnect...')

export const reconnectionFailed = Msgs.def('Reconnection failed - unable to reconnect to the server. Please refresh the page.')

export const scrollToBottom = Msgs.def('Scroll to bottom')

export const loadOlderEvents = Msgs.def('Load older events')

export const newEvents = Msgs.def('{count, plural, one {# new event} other {# new events}}', (count: number) => ({ count }))

export const previousMatch = Msgs.def('Previous match')

export const nextMatch = Msgs.def('Next match')

export const returnToLive = Msgs.def('Return to Live')

export const returnToLiveTooltip = Msgs.def('Return to live events')

export const playersOnline = Msgs.def('Players online')

export const playersInQueue = Msgs.def('Players in queue')

export const serverTickRate = Msgs.def('Server tick rate')

// -------- the chat boxes --------

export const notifyAdmins = Msgs.def('Notify admins')

export const notifyAdminsHint = Msgs.def('Warn every online admin that this warn was sent')

export const prefixNameHint = Msgs.def('Prefix the message with your username')

export const warnAdminsChannel = Msgs.def('Admins')

export const broadcastChannel = Msgs.def('Broadcast')

export const warnSelectedChannel = Msgs.def('Selected{any, select, yes { ({count})} other {}}', (count: number) => ({
	count,
	any: count > 0 ? 'yes' : 'no',
}))

export const sendHint = Msgs.def('Send (Enter)')

export const sendWarningHint = Msgs.def('Send warning (Enter)')

export const missingPermission = Msgs.def('Missing permission')

export const warnAdminsPlaceholder = Msgs.def('Warn all online admins…')

export const broadcastPlaceholder = Msgs.def('Broadcast to the server…')

export const nobodySelectedPlaceholder = Msgs.def('No players selected in the teams panel')

export const warnSelectedPlaceholder = Msgs.def(
	'Warn {count, plural, one {# selected player} other {# selected players}}…',
	(count: number) => ({ count }),
)

export const noOneToWarnPlaceholder = Msgs.def('No one to warn')

export const warnPlaceholder = Msgs.def('Warn…')

export const selectedOnly = Msgs.def('Selected Only')

// -------- the activity feed's event lines --------
//
// Each event type is one message taking the nodes the feed renders inline (a player, a squad, a team, a layer).
// The whole sentence lives here with its slots named, which is what a locale needs: word order, the connectives
// and the punctuation are all the message's, and only what the slots look like belongs to the caller.

export const chatChannelBroadcast = Msgs.def('(broadcast)')

export const chatChannelBroadcastHint = Msgs.def('admin broadcast message')

export const chatChannelAll = Msgs.def('(all)')

export const chatChannelAllHint = Msgs.def('this message was sent in all chat')

export const chatChannelAdmin = Msgs.def('(admin)')

export const chatChannelAdminHint = Msgs.def('this message was sent in admin chat')

export const broadcastFromRcon = Msgs.def('RCON')

export const broadcastFromUnknown = Msgs.def('unknown')

export const playerConnected = Msgs.def((player: React.ReactNode, team?: React.ReactNode) => ({
	react: () => (
		<>
			{player} connected{team !== undefined && <>, joining {team}</>}
		</>
	),
}))

export const playerDisconnected = Msgs.def((player: React.ReactNode) => ({
	react: () => <>{player} disconnected</>,
}))

export const enteredAdminCamera = Msgs.def((player: React.ReactNode) => ({
	react: () => <>{player} entered admin camera</>,
}))

export const exitedAdminCamera = Msgs.def((player: React.ReactNode) => ({
	react: () => <>{player} exited admin camera</>,
}))

// the reason is styled down by the caller; the separator that introduces it is part of the sentence
export const playerKicked = Msgs.def((player: React.ReactNode, reason?: React.ReactNode) => ({
	react: () => (
		<>
			{player} was kicked{reason !== undefined && <> - {reason}</>}
		</>
	),
}))

export const squadCreated = Msgs.def((creator: React.ReactNode, squad: React.ReactNode, team: React.ReactNode) => ({
	react: () => (
		<>
			{creator} created {squad} on {team}
		</>
	),
}))

export const playerBanned = Msgs.def((player: React.ReactNode, interval: string) => ({
	react: () => (
		<>
			{player} was banned reason: "{interval}"
		</>
	),
}))

export const playerWarned = Msgs.def((player: React.ReactNode, reason: string) => ({
	react: () => (
		<>
			{player} was warned: "{reason}"
		</>
	),
}))

export const playersWarned = Msgs.def((players: React.ReactNode, reason: string) => ({
	react: () => (
		<>
			{players} were warned: "{reason}"
		</>
	),
}))

export const playerCountWarned = Msgs.def((count: number, reason: string) => ({
	react: () => (
		<>
			{count} {count === 1 ? 'player' : 'players'} were warned: "{reason}"
		</>
	),
}))

export const playerChangedTeam = Msgs.def((player: React.ReactNode, team: React.ReactNode) => ({
	react: () => (
		<>
			{player} changed to {team}
		</>
	),
}))

export const playerLeftSquad = Msgs.def((player: React.ReactNode, squad: React.ReactNode, wasLeader: boolean) => ({
	react: () => (
		<>
			{player} left {squad}
			{wasLeader && ' (was leader)'}
		</>
	),
}))

export const playerJoinedSquad = Msgs.def((player: React.ReactNode, squad: React.ReactNode) => ({
	react: () => (
		<>
			{player} joined {squad}
		</>
	),
}))

export const playerPromotedToLeader = Msgs.def((player: React.ReactNode) => ({
	react: () => <>{player} promoted to squad leader</>,
}))

export const squadWasDisbanded = Msgs.def((squad: React.ReactNode) => ({
	react: () => <>{squad} was disbanded</>,
}))

export const squadLockChanged = Msgs.def((squad: React.ReactNode, locked: boolean) => ({
	react: () => (
		<>
			{squad} {locked ? 'locked' : 'unlocked'}
		</>
	),
}))

// the new name is emphasised, which is part of the sentence; the feed styles `strong` itself
export const squadRenamed = Msgs.def((squad: React.ReactNode, newName: string) => ({
	react: () => (
		<>
			{squad} renamed to <strong>"{newName}"</strong>
		</>
	),
}))

export const playerSuicide = Msgs.def((victim: React.ReactNode, wounded: boolean, weapon?: React.ReactNode) => ({
	react: () => (
		<>
			{victim} {wounded ? 'wounded themselves' : 'killed themselves'}
			{weapon}
		</>
	),
}))

export const playerTeamkilled = Msgs.def((victim: React.ReactNode, attacker: React.ReactNode, weapon?: React.ReactNode) => ({
	react: () => (
		<>
			{victim} teamkilled by {attacker}
			{weapon}
		</>
	),
}))

export const playerDowned = Msgs.def((victim: React.ReactNode, wounded: boolean, attacker: React.ReactNode, weapon?: React.ReactNode) => ({
	react: () => (
		<>
			{victim} {wounded ? 'wounded by' : 'killed by'} {attacker}
			{weapon}
		</>
	),
}))

export const withWeapon = Msgs.def(' with {weapon}', (weapon: string) => ({ weapon }))

// -------- match boundaries --------

export const newGameStarted = Msgs.def('New game started')

export const newGameOnAppStart = Msgs.def('New game detected on Application Start')

export const newGameOnRconReconnect = Msgs.def('New game detected on RCON Reconnect')

export const currentMatch = Msgs.def('Current Match')

// `{label} ({which}): {layer}` -- which is either "Current Match" or how many matches back this one is
export const newGameLine = Msgs.def((label: string, which: React.ReactNode, layer: React.ReactNode) => ({
	react: () => (
		<>
			{label} ({which}): {layer}
		</>
	),
}))

// the draw readout is coloured on its own rather than by the container, which the winner line also uses
export const draw = Msgs.def('Draw')

export const roundEndedDraw = Msgs.def((layer: React.ReactNode, outcome: React.ReactNode) => ({
	react: () => (
		<>
			Round ended ({layer}) {outcome}
		</>
	),
}))

// the ticket score is emphasised, which is part of the sentence; the feed styles `strong` itself
export const roundEndedWinner = Msgs.def(
	(layer: React.ReactNode, winner: React.ReactNode, winnerTickets: number, loserTickets: number, loser: React.ReactNode) => ({
		react: () => (
			<>
				Round ended ({layer}) {winner} won{' '}
				<strong>
					{winnerTickets} to {loserTickets}
				</strong>{' '}
				against {loser}
			</>
		),
	}),
)

// how the round was ended, when something ended it rather than the tickets running out
export const roundEndAction = Msgs.def((action: string, source: React.ReactNode, nextLayer?: React.ReactNode) => ({
	react: () => (
		<>
			({action} {source}
			{nextLayer})
		</>
	),
}))

export const roundEndBy = Msgs.def((who: React.ReactNode) => ({
	react: () => <>by {who}</>,
}))

export const roundEndVia = Msgs.def((tool: React.ReactNode) => ({
	react: () => <>via {tool}</>,
}))

export const roundEndSwitchingTo = Msgs.def((layer: React.ReactNode) => ({
	react: () => <>, switching to {layer}</>,
}))

export const rconTool = Msgs.def('RCON')

export const slmTool = Msgs.def('SLM')

// -------- the layer the server is about to play --------

export const observedNextLayer = Msgs.def((layer: React.ReactNode) => ({
	react: () => <>Server's next layer is {layer}</>,
}))

export const nextLayerSetBy = Msgs.def((who: React.ReactNode, layer: React.ReactNode) => ({
	react: () => (
		<>
			{who} set the next layer to {layer}
		</>
	),
}))

export const nextLayerSet = Msgs.def((layer: React.ReactNode) => ({
	react: () => <>Next layer set to {layer}</>,
}))

export const ingameAdmin = Msgs.def('an in-game admin')

export const anotherRconTool = Msgs.def('another RCON tool')

// -------- connection and in-game voting --------

export const ingameVoteStarted = Msgs.def('In-game vote started on the Squad server')

export const ingameVoteChoices = Msgs.def(' ({choices})', (choices: readonly string[]) => ({ choices: choices.join(', ') }))

export const rconReconnected = Msgs.def('RCON reconnected')

export const rconFirstConnected = Msgs.def('Application started, RCON connection established')

export const rconDisconnected = Msgs.def('RCON disconnected')
