// see settings.messages.tsx on why a messages module with a react target keeps React in scope
import * as React from 'react'

import * as DH from '@/lib/display-helpers'
import * as ZodUtils from '@/lib/zod-utils'
import * as I18n from '@/messages/i18n'
import type * as AAR from '@/models/admin-action-reasons.models'
import * as AppEvents from '@/models/app-events.models'
import type * as CHAT from '@/models/chat.models'
import * as LL from '@/models/layer-list.models'
import { def, join, raw, rt, t, type TString } from '@/models/messages.models'
import type * as SM from '@/models/squad.models'

// The audit log, rendered on the settings page. `describeAppEvent` in the models still builds each row's summary
// line itself.

export const auditLog = def('Audit Log')

export const auditLogBlurb = def('Recent actions taken across SLM.')

export const noEvents = def('No events yet.')

// what a row calls the actor when it cannot name them: an SLM user whose account no longer resolves, an in-game
// admin missing from the players table, or the system, which has no name to resolve in the first place
export const unnamedActors: Record<AppEvents.Actor['type'], TString> = {
	'slm-user': t('Admin'),
	'ingame-user': t('An in-game admin'),
	system: t('System'),
	plugin: t('A plugin'),
}

// -------- the activity feed's app-event lines --------
//
// One message per app-event type, each taking the nodes the feed renders inline. The actor is always a node
// because it may be a rendered player display or a resolved SLM user's name.

export const unnamedSlmUser = def('An admin')

export const systemActor = def('SLM')

export const unnamedIngameAdmin = def('An in-game admin')

// "a, b and c" -- the list a feed line names in prose rather than as a column. Intl knows each locale's own
// conjunction and separators, which no ICU pattern could hold for a list of unknown length.
export const joinNames = def((names: readonly string[]) => ({
	text: ({ locale }) => raw(new Intl.ListFormat(locale, { type: 'conjunction' }).format(names)),
}))

export const squadDisbanded = def(
	(actor: React.ReactNode, squadName: string, teamId: number, reasonLabel: string | undefined, memberCount: number) =>
		rt(
			'{actor} disbanded {squadName} (Team {teamId}){hasReason, select, yes { for {reasonLabel}} other {}}{memberCount, plural, =0 {} one {, # player} other {, # players}}',
			{ actor, squadName, teamId, reasonLabel, hasReason: reasonLabel ? 'yes' : 'no', memberCount },
		),
)

export const squadRenamed = def((actor: React.ReactNode, squadName: string, teamId: number) =>
	rt('{actor} renamed {squadName} (Team {teamId})', { actor, squadName, teamId }),
)

export const commanderDemoted = def((actor: React.ReactNode, target: React.ReactNode, reasonLabel?: string) =>
	rt('{actor} demoted {target}{hasReason, select, yes { for {reasonLabel}} other {}}', {
		actor,
		target,
		reasonLabel,
		hasReason: reasonLabel ? 'yes' : 'no',
	}),
)

export const theCommander = def('the commander')

export const aPlayer = def('a player')

export const fogOfWarToggled = def((actor: React.ReactNode, enabled: boolean) =>
	rt('{actor} turned fog of war {enabled, select, yes {on} other {off}}', { actor, enabled: enabled ? 'yes' : 'no' }),
)

export const broadcastSent = def((actor: React.ReactNode, message: string) => rt('{actor} broadcast "{message}"', { actor, message }))

export const playerTimedOut = def((actor: React.ReactNode, target: React.ReactNode, duration: string, reasonLabel?: string) =>
	rt('{actor} timed out {target} for {duration}{hasReason, select, yes { for {reasonLabel}} other {}}', {
		actor,
		target,
		duration,
		reasonLabel,
		hasReason: reasonLabel ? 'yes' : 'no',
	}),
)

export const timeoutCancelled = def((actor: React.ReactNode, target: React.ReactNode) =>
	rt("{actor} cancelled {target}'s timeout", { actor, target }),
)

export const matchEnded = def((actor: React.ReactNode) => rt('{actor} ended the match', { actor }))

export const voteStarted = def((actor: React.ReactNode, choiceCount: number) =>
	rt('{actor} started a vote ({choiceCount, plural, one {# option} other {# options}})', { actor, choiceCount }),
)

export const voteEndedEarly = def((actor: React.ReactNode) => rt('{actor} ended the vote early', { actor }))

export const voteEnded = def('The vote ended')

export const voteWinner = def((layer: React.ReactNode) => rt(': {layer} won', { layer }))

export const voteNoWinner = def(' (no winner)')

export const voteAborted = def((actor: React.ReactNode) => rt('{actor} aborted the vote', { actor }))

// a generic line for the types the feed has no renderer of its own for; the description comes from the models
export const genericLine = def((actor: React.ReactNode, description: string) => rt('{actor} {description}', { actor, description }))

// -------- MAP_SET --------

export const nextLayerRestored = def((layer: React.ReactNode) => rt("SLM restored the queue's next layer, set to {layer}", { layer }))

export const nextLayerOverrode = def((who: React.ReactNode, layer: React.ReactNode) =>
	rt('SLM overrode a layer set by {who}, next layer set to {layer}', { who, layer }),
)

// -------- the queue --------

export const queueAdvancedOnRoll = def('Queue advanced on map change')

export const queueSyncedTo = def((who: React.ReactNode) => rt('Queue synced to a layer change by {who}', { who }))

export const queueSyncedOutsideSlm = def('Queue synced to a layer change made outside SLM')

export const queueGenerated = def('SLM generated the next layer')

export const queueVoteApplied = def('Vote result applied to the queue')

export const queueSaved = def((actor: React.ReactNode, force: boolean, overrode?: string) =>
	rt('{actor} {force, select, yes {force-saved} other {saved}} the queue{hasOverride, select, yes {, overriding {overrode}} other {}}', {
		actor,
		force: force ? 'yes' : 'no',
		overrode,
		hasOverride: overrode !== undefined ? 'yes' : 'no',
	}),
)

// the net effect of a save, as a parenthetical after the headline
export const queueChangeCounts = def((counts: { added: number; removed: number; edited: number; moved: number }) => {
	const parts = [
		counts.added > 0 ? t('+{added}', { added: counts.added }) : undefined,
		counts.removed > 0 ? t('−{removed}', { removed: counts.removed }) : undefined,
		counts.edited > 0 ? t('{edited} changed', { edited: counts.edited }) : undefined,
		counts.moved > 0 ? t('reordered') : undefined,
	].filter((part) => part !== undefined)
	return parts.length > 0 ? t(' ({parts})', { parts: join(parts, ', ') }) : raw('')
})

// "now" where the server moved first and SLM followed, "set to" where SLM decided it
export const queueNextLayer = def((external: boolean, layer: React.ReactNode) =>
	rt(', next layer {external, select, yes {now} other {set to}} {layer}', { external: external ? 'yes' : 'no', layer }),
)

export const queueAndMore = def('and {count} more', (count: number) => ({ count }))

export const queueVoteChoices = def('a vote ({count, plural, one {# choice} other {# choices}}): ', (count: number) => ({ count }))

export const queueItemAdded = def((who: string, vote: React.ReactNode, layers: React.ReactNode) =>
	rt('{who} added {vote}{layers}', { who, vote, layers }),
)

export const queueItemRemoved = def((who: string, vote: React.ReactNode, layers: React.ReactNode) =>
	rt('{who} removed {vote}{layers}', { who, vote, layers }),
)

export const queueItemEdited = def((who: string, from: React.ReactNode, to: React.ReactNode) =>
	rt('{who} changed {from} to {to}', { who, from, to }),
)

export const queueItemMoved = def((who: string, layers: React.ReactNode, fromIndex: number, toIndex: number) =>
	rt('{who} moved {layers} from #{fromIndex} to #{toIndex}', { who, layers, fromIndex, toIndex }),
)

// -------- teamswaps --------

export const teamswapsExecutedOnRoll = def(
	'Queued teamswaps executed on map change ({playerCount, plural, one {# player} other {# players}})',
	(playerCount: number) => ({ playerCount }),
)

export const teamswapsExecuted = def((actor: React.ReactNode, playerCount: number) =>
	rt('{actor} executed the queued teamswaps ({playerCount, plural, one {# player} other {# players}})', { actor, playerCount }),
)

export const teamswapsDropped = def(
	'{count, plural, one {# queued teamswap dropped, the player} other {# queued teamswaps dropped, those players}} left or changed teams',
	(count: number) => ({ count }),
)

export const teamswapsCleared = def((actor: React.ReactNode) => rt('{actor} cleared the queued teamswaps', { actor }))

export const teamswapsUpdated = def((actor: React.ReactNode, added: number, removed: number, queued: number) =>
	rt('{actor} updated the queued teamswaps ({delta}), {queued} queued for next map', {
		actor,
		delta: [added > 0 ? `+${added}` : null, removed > 0 ? `−${removed}` : null].filter(Boolean).join(', '),
		queued,
	}),
)

export const teamswapLine = def((player: React.ReactNode, team: React.ReactNode, queuedBy?: string) =>
	rt('{player} to {team}{hasQueuedBy, select, yes { (queued by {queuedBy})} other {}}', {
		player,
		team,
		queuedBy,
		hasQueuedBy: queuedBy !== undefined ? 'yes' : 'no',
	}),
)

// -------- warns --------

export const warnChannel = def((actor: React.ReactNode, warnee: React.ReactNode) => rt('({actor} warned {warnee})', { actor, warnee }))

export const warnChannelHint = def('who sent this warning and who received it')

export const allAdmins = def('all admins')

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

export const warnPlayerCount = def('{count, plural, one {# player} other {# players}}', (count: number) => ({ count }))

// a grouping plus the count it covers, where naming the group alone would hide how many it reached
export const warnDescriptorWithCount = def('{descriptor} ({players})', (descriptor: string, players: string) => ({
	descriptor,
	players,
}))

// -------- the shared "{actor} {verb} {targets}{suffix}" entries --------

export const removedFromSquadSuffix = def(
	' from their squad{hasReason, select, yes { for {reasonLabel}} other {}}',
	(reasonLabel?: string) => ({ reasonLabel, hasReason: reasonLabel ? 'yes' : 'no' }),
)

export const forReasonSuffix = def(' for {reasonLabel}', (reasonLabel: string) => ({ reasonLabel }))

export const killReasonSuffix = def(': "{reason}"', (reason: string) => ({ reason }))

export const swappedTeamsSuffix = def(' to the other team')

export const switchRequestFulfilledSuffix = def(' to the other team (switch request)')

export const targetVerbs = { removed: 'removed', kicked: 'kicked', killed: 'killed', swapped: 'swapped' }

export type TargetVerb = keyof typeof targetVerbs

export const actionOnNamedTargets = def(
	(actor: React.ReactNode, verb: TargetVerb, targets: React.ReactNode, count: number, suffix: React.ReactNode) =>
		rt('{actor} {verb} {targets}{many, select, yes { ({count, plural, one {# player} other {# players}})} other {}}{suffix}', {
			actor,
			verb: targetVerbs[verb],
			targets,
			count,
			many: count > 1 ? 'yes' : 'no',
			suffix,
		}),
)

export const actionOnCountedTargets = def((actor: React.ReactNode, verb: TargetVerb, count: number, suffix: React.ReactNode) =>
	rt('{actor} {verb} {count, plural, one {a player} other {# players}}{suffix}', { actor, verb: targetVerbs[verb], count, suffix }),
)

// ---- the audit log's summary line ----
//
// A short description of the action WITHOUT the actor, which the caller prepends. Read by the audit log on the
// settings page, by the activity feed for the types it has no renderer of its own for, and by the in-game
// warn-all-admins notice, so it stays a plain string rather than a react target.
// `playerName` resolves an eos id for the types that name a player the caller cannot otherwise identify.

const QUEUE_UPDATE_VERBS: Record<AppEvents.QueueUpdateKind, TString> = {
	roll: t('advanced the queue on map change'),
	'external-layer-change': t('synced the queue to an external layer change'),
	generated: t('generated the next layer'),
	'vote-result': t('applied the vote result to the queue'),
	'force-save': t('force-saved the queue'),
	save: t('updated the queue'),
}

// a short human-readable description of the action, WITHOUT the actor (the caller prepends the actor's name).
// used by the audit log; the activity feed has its own richer per-type renderers.
// `playerName` resolves an eos id for the types that name a player the caller can't otherwise identify.
export function describeAppEvent(e: AppEvents.AppEvent, playerName?: (id: SM.PlayerId) => string | undefined): string {
	const players = (n: number) => `${n} ${n === 1 ? 'player' : 'players'}`
	const forReason = (reason: AAR.AppliedReason | undefined) => (reason?.label ? ` for ${reason.label}` : '')
	switch (e.type) {
		case 'PLAYER_WARNED':
			// preset-reason warns embed the label in the delivered message, so it isn't repeated here
			return `warned ${players(e.targets.length)}: ${e.message}`
		case 'SQUAD_DISBANDED':
			return `disbanded ${e.squadName} (Team ${e.teamId})${forReason(e.reason)}`
		case 'PLAYER_REMOVED_FROM_SQUAD':
			return `removed ${players(e.targets.length)} from squad${forReason(e.reason)}`
		case 'TEAM_CHANGE_FORCED':
			return `swapped ${players(e.targets.length)} to the other team`
		case 'SWITCH_REQUESTS_FULFILLED':
			return `switched ${players(e.targets.length)} at their request${e.movedConnector ? ', moving a connecting player aside' : ''}`
		case 'PLAYER_KILLED':
			// preset-reason kills embed the label in the delivered reason, so it isn't repeated here
			return `killed ${players(e.targets.length)}${e.reason ? `: "${e.reason}"` : ''}`
		case 'SQUAD_RENAMED':
			return `renamed ${e.squadName} (Team ${e.teamId})`
		case 'COMMANDER_DEMOTED':
			return `demoted a commander${forReason(e.reason)}`
		case 'FOG_OF_WAR_TOGGLED':
			return `turned fog of war ${e.enabled ? 'on' : 'off'}`
		case 'BROADCAST_SENT':
			// preset broadcasts embed nothing extra; the label is implicit in the configured message
			return `broadcast: "${e.message}"`
		case 'PLAYER_KICKED':
			return `kicked ${players(e.targets.length)}${forReason(e.reason)}`
		case 'PLAYER_TIMED_OUT':
			return `timed out 1 player for ${ZodUtils.formatHumanTime(e.durationMs)}${forReason(e.reason)}`
		case 'TIMEOUT_CANCELLED':
			return `cancelled a player's timeout`
		case 'MATCH_ENDED':
			return 'ended the match'
		case 'PLUGIN_EVENT':
			return e.message
		case 'PLUGIN_DATA_PURGED':
			return `deleted ${e.pluginId}'s leftover data (${e.tables.length} ${e.tables.length === 1 ? 'table' : 'tables'})`
		case 'VOTE_STARTED':
			return `started a vote (${e.choiceCount} ${e.choiceCount === 1 ? 'option' : 'options'})`
		case 'VOTE_ENDED': {
			const verb = e.reason === 'ended-early' ? 'ended a vote early' : 'a vote ended'
			const winner = e.winnerLayerId ? `, ${DH.toShortLayerNameFromId(e.winnerLayerId)} won` : ''
			const turnout = e.totalVotes !== undefined ? ` (${e.totalVotes} ${e.totalVotes === 1 ? 'vote' : 'votes'})` : ''
			return `${verb}${winner}${turnout}`
		}
		case 'VOTE_ABORTED':
			return 'aborted a vote'
		case 'QUEUE_UPDATED': {
			const verb = I18n.ambient.text(QUEUE_UPDATE_VERBS[AppEvents.queueUpdateKind(e)])
			// user-edit / roll saves have a companion MAP_SET row that states the next layer; external syncs don't
			if (e.trigger !== 'external-layer-change') return verb
			const nextBefore = LL.getNextLayerId(e.prevList)
			const nextAfter = LL.getNextLayerId(e.list)
			return nextAfter !== null && nextAfter !== nextBefore
				? I18n.ambient.text(t('{verb}, next layer now {nextLayer}', { verb, nextLayer: DH.toShortLayerNameFromId(nextAfter) }))
				: verb
		}
		case 'TEAMSWAPS_UPDATED': {
			const changes = AppEvents.summarizeTeamswapChanges(e)
			const added = changes.filter((c) => c.kind === 'added').length
			const removed = changes.filter((c) => c.kind === 'removed').length
			// the caller prepends the actor, which is 'SLM' when the map roll fired the queue
			if (e.trigger === 'executed' || e.trigger === 'swapped-now') {
				return `executed the queued teamswaps (${players(removed)})`
			}
			if (e.trigger === 'roster-change') return `dropped ${removed} queued teamswap${removed === 1 ? '' : 's'} (roster changed)`
			if (e.swaps.size === 0) return 'cleared the queued teamswaps'
			const parts = [added > 0 ? `+${added}` : null, removed > 0 ? `−${removed}` : null].filter(Boolean)
			return `updated the queued teamswaps (${parts.join(', ')})`
		}
		case 'LAYER_REQUEST_ADDED':
			return `requested a layer: "${e.description}"`
		case 'LAYER_REQUEST_REMOVED': {
			const n = e.itemIds.length
			return `removed ${n} layer request${n === 1 ? '' : 's'} (${e.descriptions.join('; ')})`
		}
		case 'LAYER_REQUEST_CONSUMED': {
			const n = e.itemIds.length
			return `satisfied ${n} layer request${n === 1 ? '' : 's'} (${e.descriptions.join('; ')}), next layer ${DH.toShortLayerNameFromId(
				e.layerId,
			)}`
		}
		case 'MAP_SET': {
			const layer = DH.toShortLayerNameFromId(e.layerId)
			if (e.reason === 'override') {
				// nothing was witnessed being overridden in the 'unknown' case: the layer was simply already set
				if (!e.overrode || e.overrode.type === 'unknown') return `restored the queue's next layer, set to ${layer}`
				const who =
					e.overrode.type === 'player' ? ` by ${playerName?.(e.overrode.playerId) ?? 'an in-game admin'}` : ' by another RCON tool'
				return `overrode an external layer set${who}, next layer set to ${layer}`
			}
			return `set next layer to ${layer}`
		}
		case 'SETTINGS_UPDATED': {
			const scope = e.serverId ? 'server settings' : 'global settings'
			if (!e.changes || e.changes.length === 0) return `updated ${scope}`
			// the paths are the point of the entry; the values are in the expanded payload
			const shown = e.changes
				.slice(0, 3)
				.map((c) => c.path)
				.join(', ')
			const rest = e.changes.length > 3 ? ` and ${e.changes.length - 3} more` : ''
			return `updated ${scope}: ${shown}${rest}`
		}
		case 'SERVER_REGISTRY_CHANGED': {
			const verb = e.action === 'set-default' ? 'set default' : e.action
			return `${verb} server "${e.targetServerName ?? e.targetServerId}"`
		}
		case 'FILTER_CHANGED': {
			const name = e.filterName ? `"${e.filterName}"` : e.filterId
			const fields = e.action === 'updated' && e.changedFields?.length ? ` (${e.changedFields.join(', ')})` : ''
			return `${e.action} filter ${name}${fields}`
		}
		case 'FILTER_CONTRIBUTOR_CHANGED': {
			const name = e.filterName ? `"${e.filterName}"` : e.filterId
			const who = e.contributor?.type === 'role' ? `role ${e.contributor.roleId}` : 'a contributor'
			return e.action === 'added' ? `added ${who} to filter ${name}` : `removed ${who} from filter ${name}`
		}
		case 'USER_ACCOUNT_CHANGED': {
			const count = e.steamIds?.length ?? 0
			const accounts = count > 1 ? `${count} Steam accounts` : 'their Steam account'
			if (e.action === 'steam-linked') return `linked ${accounts}`
			if (e.action === 'steam-unlinked') return `unlinked ${accounts}`
			if (e.nickname === undefined) return 'updated their nickname'
			return e.nickname === null ? 'cleared their nickname' : `set their nickname to "${e.nickname}"`
		}
		case 'PLAYER_FLAGS_UPDATED': {
			const describe = (sign: string) => (f: { name: string; reason?: string }) => `${sign}${f.name}${f.reason ? ` (${f.reason})` : ''}`
			const changes = [...e.added.map(describe('+')), ...e.removed.map(describe('−'))].join(', ')
			return `updated Battlemetrics flags for ${playerName?.(e.playerId) ?? `player ${e.playerId}`}${changes ? `: ${changes}` : ''}`
		}
		case 'APP_STARTED':
			return `SLM started${e.version ? ` (${e.version})` : ''}`
		case 'APP_RESTARTED':
			return 'restarted SLM'
		case 'BACKUP_CREATED': {
			const size = `${(e.sizeBytes / 1024 / 1024).toFixed(1)} MB`
			const upload = e.uploaded === undefined ? '' : e.uploaded ? ', uploaded offsite' : ', offsite upload FAILED'
			const pruned =
				e.pruned && e.pruned.events > 0
					? `, pruned ${e.pruned.events} events from ${e.pruned.matches} ${e.pruned.matches === 1 ? 'match' : 'matches'}`
					: ''
			const what = e.reason === 'pre-migration' ? 'backed up the database before migrating it' : 'backed up the database'
			return `${what}, to ${e.fileName} (${size})${upload}${pruned}`
		}
	}
}
