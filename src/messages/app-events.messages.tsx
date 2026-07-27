// see settings.messages.tsx on why a messages module with a react target keeps React in scope
import * as React from 'react'

import * as Msgs from '@/messages/shared'
import type * as AppEvents from '@/models/app-events.models'
import type * as CHAT from '@/models/chat.models'

// The audit log, rendered on the settings page. `describeAppEvent` in the models still builds each row's summary
// line itself.

export const auditLog = Msgs.def(() => ({ text: () => 'Audit Log' }))

export const auditLogBlurb = Msgs.def(() => ({ text: () => 'Recent actions taken across SLM.' }))

export const noEvents = Msgs.def(() => ({ text: () => 'No events yet.' }))

// what a row calls the actor when it cannot name them: an SLM user whose account no longer resolves, an in-game
// admin missing from the players table, or the system, which has no name to resolve in the first place
export const unnamedActors: Record<AppEvents.Actor['type'], string> = {
	'slm-user': 'Admin',
	'ingame-user': 'An in-game admin',
	system: 'System',
}

// -------- the activity feed's app-event lines --------
//
// One message per app-event type, each taking the nodes the feed renders inline. The actor is always a node
// because it may be a rendered player display or a resolved SLM user's name.

export const unnamedSlmUser = Msgs.def(() => ({ text: () => 'An admin' }))

export const systemActor = Msgs.def(() => ({ text: () => 'SLM' }))

export const unnamedIngameAdmin = Msgs.def(() => ({ text: () => 'An in-game admin' }))

// "a, b and c" -- the list a feed line names in prose rather than as a column
export const joinNames = Msgs.def((names: readonly string[]) => ({
	text: () => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`),
}))

export const squadDisbanded = Msgs.def(
	(actor: React.ReactNode, squadName: string, teamId: number, reasonLabel: string | undefined, memberCount: number) => ({
		react: () => (
			<>
				{actor} disbanded {squadName} (Team {teamId}){reasonLabel ? ` for ${reasonLabel}` : ''}
				{memberCount > 0 ? `, ${memberCount} ${memberCount === 1 ? 'player' : 'players'}` : ''}
			</>
		),
	}),
)

export const squadRenamed = Msgs.def((actor: React.ReactNode, squadName: string, teamId: number) => ({
	react: () => (
		<>
			{actor} renamed {squadName} (Team {teamId})
		</>
	),
}))

export const commanderDemoted = Msgs.def((actor: React.ReactNode, target: React.ReactNode, reasonLabel?: string) => ({
	react: () => (
		<>
			{actor} demoted {target}
			{reasonLabel ? ` for ${reasonLabel}` : ''}
		</>
	),
}))

export const theCommander = Msgs.def(() => ({ text: () => 'the commander' }))

export const aPlayer = Msgs.def(() => ({ text: () => 'a player' }))

export const fogOfWarToggled = Msgs.def((actor: React.ReactNode, enabled: boolean) => ({
	react: () => (
		<>
			{actor} turned fog of war {enabled ? 'on' : 'off'}
		</>
	),
}))

export const broadcastSent = Msgs.def((actor: React.ReactNode, message: string) => ({
	react: () => (
		<>
			{actor} broadcast "{message}"
		</>
	),
}))

export const playerTimedOut = Msgs.def((actor: React.ReactNode, target: React.ReactNode, duration: string, reasonLabel?: string) => ({
	react: () => (
		<>
			{actor} timed out {target} for {duration}
			{reasonLabel ? ` for ${reasonLabel}` : ''}
		</>
	),
}))

export const timeoutCancelled = Msgs.def((actor: React.ReactNode, target: React.ReactNode) => ({
	react: () => (
		<>
			{actor} cancelled {target}'s timeout
		</>
	),
}))

export const matchEnded = Msgs.def((actor: React.ReactNode) => ({
	react: () => <>{actor} ended the match</>,
}))

export const voteStarted = Msgs.def((actor: React.ReactNode, choiceCount: number) => ({
	react: () => (
		<>
			{actor} started a vote ({choiceCount} {choiceCount === 1 ? 'option' : 'options'})
		</>
	),
}))

export const voteEndedEarly = Msgs.def((actor: React.ReactNode) => ({
	react: () => <>{actor} ended the vote early</>,
}))

export const voteEnded = Msgs.def(() => ({ text: () => 'The vote ended' }))

export const voteWinner = Msgs.def((layer: React.ReactNode) => ({
	react: () => <>: {layer} won</>,
}))

export const voteNoWinner = Msgs.def(() => ({ text: () => ' (no winner)' }))

export const voteAborted = Msgs.def((actor: React.ReactNode) => ({
	react: () => <>{actor} aborted the vote</>,
}))

// a generic line for the types the feed has no renderer of its own for; the description comes from the models
export const genericLine = Msgs.def((actor: React.ReactNode, description: string) => ({
	react: () => (
		<>
			{actor} {description}
		</>
	),
}))

// -------- MAP_SET --------

export const nextLayerRestored = Msgs.def((layer: React.ReactNode) => ({
	react: () => <>SLM restored the queue's next layer, set to {layer}</>,
}))

export const nextLayerOverrode = Msgs.def((who: React.ReactNode, layer: React.ReactNode) => ({
	react: () => (
		<>
			SLM overrode a layer set by {who}, next layer set to {layer}
		</>
	),
}))

// -------- the queue --------

export const queueAdvancedOnRoll = Msgs.def(() => ({ text: () => 'Queue advanced on map change' }))

export const queueSyncedTo = Msgs.def((who: React.ReactNode) => ({
	react: () => <>Queue synced to a layer change by {who}</>,
}))

export const queueSyncedOutsideSlm = Msgs.def(() => ({ text: () => 'Queue synced to a layer change made outside SLM' }))

export const queueGenerated = Msgs.def(() => ({ text: () => 'SLM generated the next layer' }))

export const queueVoteApplied = Msgs.def(() => ({ text: () => 'Vote result applied to the queue' }))

export const queueSaved = Msgs.def((actor: React.ReactNode, force: boolean, overrode?: string) => ({
	react: () => (
		<>
			{actor} {force ? 'force-saved' : 'saved'} the queue
			{overrode !== undefined && `, overriding ${overrode}`}
		</>
	),
}))

// the net effect of a save, as a parenthetical after the headline
export const queueChangeCounts = Msgs.def((counts: { added: number; removed: number; edited: number; moved: number }) => ({
	text: () => {
		const parts = [
			counts.added > 0 ? `+${counts.added}` : null,
			counts.removed > 0 ? `−${counts.removed}` : null,
			counts.edited > 0 ? `${counts.edited} changed` : null,
			counts.moved > 0 ? 'reordered' : null,
		].filter(Boolean)
		return parts.length > 0 ? ` (${parts.join(', ')})` : ''
	},
}))

// "now" where the server moved first and SLM followed, "set to" where SLM decided it
export const queueNextLayer = Msgs.def((external: boolean, layer: React.ReactNode) => ({
	react: () => (
		<>
			, next layer {external ? 'now' : 'set to'} {layer}
		</>
	),
}))

export const queueAndMore = Msgs.def((count: number) => ({ text: () => `and ${count} more` }))

export const queueVoteChoices = Msgs.def((count: number) => ({
	text: () => `a vote (${count} ${count === 1 ? 'choice' : 'choices'}): `,
}))

export const queueItemAdded = Msgs.def((who: string, vote: React.ReactNode, layers: React.ReactNode) => ({
	react: () => (
		<>
			{who} added {vote}
			{layers}
		</>
	),
}))

export const queueItemRemoved = Msgs.def((who: string, vote: React.ReactNode, layers: React.ReactNode) => ({
	react: () => (
		<>
			{who} removed {vote}
			{layers}
		</>
	),
}))

export const queueItemEdited = Msgs.def((who: string, from: React.ReactNode, to: React.ReactNode) => ({
	react: () => (
		<>
			{who} changed {from} to {to}
		</>
	),
}))

export const queueItemMoved = Msgs.def((who: string, layers: React.ReactNode, fromIndex: number, toIndex: number) => ({
	react: () => (
		<>
			{who} moved {layers} from #{fromIndex} to #{toIndex}
		</>
	),
}))

// -------- teamswaps --------

export const teamswapsExecutedOnRoll = Msgs.def((playerCount: number) => ({
	text: () => `Queued teamswaps executed on map change (${playerCount} ${playerCount === 1 ? 'player' : 'players'})`,
}))

export const teamswapsExecuted = Msgs.def((actor: React.ReactNode, playerCount: number) => ({
	react: () => (
		<>
			{actor} executed the queued teamswaps ({playerCount} {playerCount === 1 ? 'player' : 'players'})
		</>
	),
}))

export const teamswapsDropped = Msgs.def((count: number) => ({
	text: () =>
		`${count} queued teamswap${count === 1 ? '' : 's'} dropped, ${count === 1 ? 'the player' : 'those players'} left or changed teams`,
}))

export const teamswapsCleared = Msgs.def((actor: React.ReactNode) => ({
	react: () => <>{actor} cleared the queued teamswaps</>,
}))

export const teamswapsUpdated = Msgs.def((actor: React.ReactNode, added: number, removed: number, queued: number) => ({
	react: () => (
		<>
			{actor} updated the queued teamswaps (
			{[added > 0 ? `+${added}` : null, removed > 0 ? `−${removed}` : null].filter(Boolean).join(', ')}), {queued} queued for next map
		</>
	),
}))

export const teamswapLine = Msgs.def((player: React.ReactNode, team: React.ReactNode, queuedBy?: string) => ({
	react: () => (
		<>
			{player} to {team}
			{queuedBy !== undefined && ` (queued by ${queuedBy})`}
		</>
	),
}))

// -------- warns --------

export const warnChannel = Msgs.def((actor: React.ReactNode, warnee: React.ReactNode) => ({
	react: () => (
		<>
			({actor} warned {warnee})
		</>
	),
}))

export const warnChannelHint = Msgs.def(() => ({ text: () => 'who sent this warning and who received it' }))

export const allAdmins = Msgs.def(() => ({ text: () => 'all admins' }))

// How a warn's targets are named when they are not listed individually. A plain function rather than a message:
// a bare list of players has no descriptor at all, and a target that can return nothing is not a message (see
// the teamswap rejection lookup).
export function warnTargetDescriptor(summary: CHAT.WarnSummary): string | null {
	switch (summary.type) {
		case 'everyone':
			return 'the entire server'
		case 'all-admins':
			return 'all admins'
		case 'teams':
			return summary.teamIds.length === 2 ? 'both teams' : `everyone on Team ${summary.teamIds[0]}`
		case 'squads': {
			const names = summary.squads.map((s) => s.squadName).join(', ')
			if (summary.otherPlayerCount > 0) {
				return `${names} and ${summary.otherPlayerCount} other ${summary.otherPlayerCount === 1 ? 'player' : 'players'}`
			}
			return names
		}
		case 'players':
			return null
	}
}

export const warnPlayerCount = Msgs.def((count: number) => ({ text: () => `${count} ${count === 1 ? 'player' : 'players'}` }))

// a grouping plus the count it covers, where naming the group alone would hide how many it reached
export const warnDescriptorWithCount = Msgs.def((descriptor: string, players: string) => ({
	text: () => `${descriptor} (${players})`,
}))

// -------- the shared "{actor} {verb} {targets}{suffix}" entries --------

export const removedFromSquadSuffix = Msgs.def((reasonLabel?: string) => ({
	text: () => (reasonLabel ? ` from their squad for ${reasonLabel}` : ' from their squad'),
}))

export const forReasonSuffix = Msgs.def((reasonLabel: string) => ({ text: () => ` for ${reasonLabel}` }))

export const killReasonSuffix = Msgs.def((reason: string) => ({ text: () => `: "${reason}"` }))

export const swappedTeamsSuffix = Msgs.def(() => ({ text: () => ' to the other team' }))

export const targetVerbs = { removed: 'removed', kicked: 'kicked', killed: 'killed', swapped: 'swapped' }

export type TargetVerb = keyof typeof targetVerbs

export const actionOnNamedTargets = Msgs.def(
	(actor: React.ReactNode, verb: TargetVerb, targets: React.ReactNode, count: number, suffix: React.ReactNode) => ({
		react: () => (
			<>
				{actor} {targetVerbs[verb]} {targets}
				{count > 1 && (
					<>
						{' '}
						({count} {count === 1 ? 'player' : 'players'})
					</>
				)}
				{suffix}
			</>
		),
	}),
)

export const actionOnCountedTargets = Msgs.def((actor: React.ReactNode, verb: TargetVerb, count: number, suffix: React.ReactNode) => ({
	react: () => (
		<>
			{actor} {targetVerbs[verb]} {count === 1 ? 'a player' : `${count} players`}
			{suffix}
		</>
	),
}))
