// The inline pieces a feed row is made of -- a player, a squad, a team, a layer, a timestamp -- built as dom.
//
// These are the single implementation. The react components of the same names (player-display.tsx and friends)
// mount what is built here, so there is one piece of markup per atom rather than two that drift.

import * as dateFns from 'date-fns'

import * as DH from '@/lib/display-helpers'
import * as Dom from '@/lib/dom'
import { withThrown } from '@/lib/error'
import * as Obj from '@/lib/object-utils'
import { isNullOrUndef } from '@/lib/type-guards'
import * as Typo from '@/lib/typography'
import { cn } from '@/lib/utils'
import * as I18n from '@/messages/i18n'
import * as I18nDom from '@/messages/i18n-dom'
import * as L_Msgs from '@/messages/layer.messages'
import * as SM_Msgs from '@/messages/squad.messages'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import * as L from '@/models/layer'
import * as LQY from '@/models/layer-queries.models'
import type * as MH from '@/models/match-history.models'
import * as MHModels from '@/models/match-history.models'
import * as SM from '@/models/squad.models'

import { icon } from './icons'
import * as RC from './render-context'

const trDom = I18nDom.ambient

// -------- time --------

// `HH:mm` in local time, by hand: this runs once per row and date-fns' formatter is not worth it for two fields.
// The full timestamp the tooltip shows is not built here at all -- the epoch rides on the element and the tooltip
// formats it when it opens (see TIP_TIME_ATTR).
function shortTime(time: number) {
	const at = new Date(time)
	const hours = at.getHours()
	const minutes = at.getMinutes()
	return `${hours < 10 ? '0' : ''}${hours}:${minutes < 10 ? '0' : ''}${minutes}`
}

export function formatFullTime(time: number) {
	return dateFns.format(time, 'yyyy-MM-dd HH:mm:ss zzz')
}

export function eventTime(time: number): HTMLElement {
	return Dom.el(
		'button',
		{ type: 'button', class: 'shrink-0', 'data-state': 'closed', [RC.TIP_TIME_ATTR]: time },
		Dom.el('span', { class: 'text-muted-foreground font-mono text-xs' }, shortTime(time)),
	)
}

// -------- layers --------

export function mapLayerDisplay(
	layer: string,
	extraLayerStyles?: Record<string, string | undefined>,
	className?: string,
): HTMLElement | string {
	const styles = extraLayerStyles ?? {}
	let segments = L.parseLayerStringSegment(layer)
	if (segments) segments = L.applyBackwardsCompatMappings(segments)
	if (!segments || segments.Gamemode === 'Training') return segments?.Map ?? layer
	const collection = segments.Collection ? L.StaticLayerComponents.collectionAbbreviations[segments.Collection] : null
	return Dom.el(
		'span',
		{ class: cn(styles.Layer, styles.Size, className) },
		Dom.el('span', { class: styles.Map }, segments.Map),
		segments.Gamemode && ['_', Dom.el('span', { class: styles.Gamemode }, segments.Gamemode)],
		segments.LayerVersion && ['_', Dom.el('span', { class: styles.Layer }, segments.LayerVersion.toLowerCase())],
		segments.Collection && collection !== null && ['_', Dom.el('span', { class: styles.Collection }, collection)],
	)
}

// -------- teams --------

const TEAM_NAME_COLOR = '--team-name-color'
const trTeamName = trDom.withTags({
	team: (chunks) => Dom.el('span', { class: 'font-semibold', style: `color:var(${TEAM_NAME_COLOR})` }, chunks),
})

export function teamIndicator(team: MH.NormedTeamId | SM.TeamId): HTMLElement {
	return Dom.el('span', { class: 'font-mono text', style: `color:${DH.TEAM_COLORS[`team${team}`]}` }, `(${team})`)
}

export type TeamFactionProps = {
	className?: string
	parity: number
	layer: L.UnvalidatedLayer | L.LayerId
	team: SM.TeamId
	includeUnits?: boolean
	showAltTeamIndicator?: boolean
	leadWithTeamName?: boolean
	extraStyles?: Record<keyof L.KnownLayer, string | undefined>
	/** whether teams read as A/B rather than 1/2; resolved by the caller from the global setting */
	normalized: boolean
}

export function teamFactionDisplay(props: TeamFactionProps): HTMLElement | null {
	const displayTeamsNormalized = props.normalized
	const [partialLayer, error] = withThrown(() => (typeof props.layer === 'string' ? L.toLayer(props.layer) : props.layer))

	if (error || !partialLayer) {
		const layerId = typeof props.layer === 'string' ? props.layer : props.layer.id
		return Dom.el(
			'span',
			{
				class: 'inline-block whitespace-nowrap text-destructive cursor-help',
				[RC.TIP_HEADING_ATTR]: I18n.ambient.text(SM_Msgs.failedToParseLayer()),
				[RC.TIP_ATTR]: error instanceof Error ? error.message : 'Unknown error',
			},
			layerId,
		)
	}

	const allianceProp = props.team === 1 ? 'Alliance_1' : 'Alliance_2'
	const factionProp = props.team === 1 ? 'Faction_1' : 'Faction_2'
	const unitProp = props.team === 1 ? 'Unit_1' : 'Unit_2'

	const faction = partialLayer[factionProp]
	if (!faction) return null

	const unit = partialLayer[unitProp]
	const shortUnit = unit !== undefined ? DH.toShortUnit(unit) : undefined

	const attrs = [
		{ color: [DH.TEAM_COLORS.team1, DH.TEAM_COLORS.team2][props.team - 1], title: ['Team 1', 'Team 2'][props.team - 1], id: props.team },
		{
			color: [DH.TEAM_COLORS.teamA, DH.TEAM_COLORS.teamB][(props.parity + props.team - 1) % 2],
			title: ['Team A', 'Team B'][(props.parity + props.team - 1) % 2],
			id: MHModels.getNormedTeamId(props.team, props.parity),
		},
	] as { color: string; title: string; id: MH.NormedTeamId | SM.TeamId }[]
	if (displayTeamsNormalized) attrs.reverse()

	const factionElt = Dom.el(
		'span',
		{ class: cn(props.extraStyles?.[allianceProp], props.extraStyles?.[factionProp]) },
		props.leadWithTeamName ? trTeamName.richText(L_Msgs.teamName(attrs[0].id, faction, true)) : faction,
	)

	return Dom.el(
		'span',
		{ class: cn('inline-block whitespace-nowrap', props.className) },
		Dom.el(
			'span',
			{
				title: attrs[0].title,
				style: props.leadWithTeamName ? `${TEAM_NAME_COLOR}:${attrs[0].color}` : `color:${attrs[0].color}`,
				class: props.leadWithTeamName ? 'font-normal text-muted-foreground' : 'font-semibold',
			},
			factionElt,
			props.includeUnits && shortUnit && Dom.el('span', { class: props.extraStyles?.[unitProp] }, ` ${shortUnit}`),
			props.showAltTeamIndicator && teamIndicator(attrs[1].id),
		),
	)
}

export function teamsDisplay(
	layer: L.UnvalidatedLayer | L.LayerId,
	teamParity: number | undefined,
	displayLayersNormalized: boolean,
	extraStyles?: Record<keyof L.KnownLayer, string | undefined>,
	includeUnits = true,
): [HTMLElement | null, HTMLElement | null] {
	const parity = teamParity ?? 0
	const [left, right] = MHModels.getDisplayedTeamOrder(parity, displayLayersNormalized).map((normedTeam) =>
		teamFactionDisplay({
			parity,
			includeUnits,
			layer,
			team: MHModels.getDenormedTeamId(normedTeam, parity),
			showAltTeamIndicator: true,
			normalized: displayLayersNormalized,
			extraStyles,
		}),
	)
	return [left, right]
}

export type MatchTeamProps = {
	matchId?: number | null
	teamId: SM.TeamId | MH.NormedTeamId
	includeUnits?: boolean
	showAltTeamIndicator?: boolean
	leadWithTeamName?: boolean
	className?: string
}

export function matchTeamDisplay(ctx: RC.RenderCtx, props: MatchTeamProps): HTMLElement | null {
	let match: MH.MatchDetails | undefined
	if (props.matchId === undefined || props.matchId === null) {
		match = ctx.latestMatch
		if (!match?.isCurrentMatch) return null
	} else {
		match = ctx.matchById(props.matchId)
	}
	if (!match) return null
	return teamFactionDisplay({
		normalized: ctx.displayTeamsNormalized,
		className: props.className,
		parity: match.ordinal,
		team: MHModels.getDenormedTeamId(props.teamId, match.ordinal),
		layer: match.layerId,
		includeUnits: props.includeUnits,
		showAltTeamIndicator: props.showAltTeamIndicator,
		leadWithTeamName: props.leadWithTeamName,
	})
}

// -------- short layer name --------

const BACKFILLED_STYLE = 'text-gray-500'

export type ShortLayerNameProps = {
	normalized: boolean
	layerId: L.LayerId
	teamParity?: number
	backfillLayerId?: L.LayerId
	matchDescriptors?: LQY.MatchDescriptor[]
	allowShowInfo?: boolean
	tourId?: string
	className?: string
}

export function shortLayerNameContent(props: ShortLayerNameProps): Dom.Child {
	const partialLayer = Obj.trimUndefined(L.toLayer(props.layerId))
	const backfillLayer = props.backfillLayerId ? L.toLayer(props.backfillLayerId) : undefined

	let violated: Map<keyof L.KnownLayer, LQY.MatchDescriptor> = new Map()
	if (props.matchDescriptors && !isNullOrUndef(props.teamParity)) {
		violated = LQY.resolveRepeatedFieldToDescriptorMap(props.matchDescriptors, props.teamParity)
	}
	const combineStyles = (prop: keyof L.KnownLayer) => {
		const styles: string[] = []
		if (!partialLayer[prop] && !!backfillLayer?.[prop]) styles.push(BACKFILLED_STYLE)
		if (violated.has(prop)) styles.push(Typo.ConstraintViolationDescriptor)
		return styles.length > 0 ? styles.join(' ') : undefined
	}
	const extraStyles = {
		id: undefined,
		Layer: combineStyles('Layer'),
		Size: combineStyles('Size'),
		Map: combineStyles('Map'),
		Gamemode: combineStyles('Gamemode'),
		LayerVersion: combineStyles('LayerVersion'),
		Faction_1: combineStyles('Faction_1'),
		Unit_1: combineStyles('Unit_1'),
		Alliance_1: combineStyles('Alliance_1'),
		Faction_2: combineStyles('Faction_2'),
		Unit_2: combineStyles('Unit_2'),
		Alliance_2: combineStyles('Alliance_2'),
		Collection: combineStyles('Collection'),
	} satisfies Record<keyof L.KnownLayer, string | undefined>

	if (!partialLayer.Layer) return props.layerId.slice('RAW:'.length)

	const backfilled = { ...(backfillLayer ?? {}), ...partialLayer }
	const hasFactions = !!backfilled.Faction_1 && !!backfilled.Faction_2
	const [leftTeamElt, rightTeamElt] = hasFactions
		? teamsDisplay(backfilled, props.teamParity ?? 0, props.normalized, extraStyles)
		: [null, null]

	return [
		backfilled.Layer && mapLayerDisplay(backfilled.Layer, extraStyles),
		hasFactions && [
			icon('Dot', 'self-center'),
			leftTeamElt,
			Dom.el('span', { class: 'mx-1' }, I18n.ambient.text(L_Msgs.versus())),
			rightTeamElt,
		],
	]
}

/** Opens the layer info window. The react ShortLayerName wraps the same content in an OpenWindowInteraction. */
export function layerInfoButton(layerId: L.LayerId, content: Dom.Child): HTMLElement {
	return RC.setWindowTarget(
		Dom.el('button', { type: 'button', class: 'text-primary underline-offset-4 [&:hover>span]:underline' }, content),
		{ windowId: WINDOW_ID.enum['layer-info'], arg: { layerId }, preload: true },
	)
}

/**
 * A layer's name, as the feed draws it.
 *
 * flex-wrap so a long "Map_Gamemode_v1 . FactionA vs FactionB" can break across lines in a narrow container; each
 * segment stays intact because it carries its own nowrap.
 */
export function shortLayerName(props: ShortLayerNameProps): HTMLElement | string {
	const content = shortLayerNameContent(props)
	if (typeof content === 'string') return content
	const span = Dom.el('span', { 'data-tour': props.tourId, class: cn('inline-flex flex-wrap items-baseline', props.className) }, content)
	if ((props.allowShowInfo ?? true) && L.isKnownLayer(props.layerId)) return layerInfoButton(props.layerId, span)
	return span
}

// -------- players and squads --------

export type PlayerDisplayProps = {
	player: SM.Player
	showTeam?: boolean
	showSquad?: boolean
	showRole?: boolean
	className?: string
	matchId?: number | null
	disableContextMenu?: boolean
}

export function playerDisplay(ctx: RC.RenderCtx, props: PlayerDisplayProps): HTMLElement {
	const player = props.player
	const playerId = SM.PlayerIds.getPlayerId(player.ids)
	const groupColor = ctx.groupColor(playerId, player)

	const button = Dom.el(
		'button',
		{
			type: 'button',
			class: 'font-bold hover:underline cursor-pointer',
			style: groupColor ? `color:${groupColor}` : undefined,
		},
		player.ids.username,
	)
	RC.setColourTarget(button, playerId, player)
	// frame: 'attach', not 'require': the window renders what it can without a live server behind it
	RC.setWindowTarget(button, {
		windowId: WINDOW_ID.enum['player-details'],
		arg: { playerId },
		frame: 'attach',
		matchId: props.matchId,
		preload: true,
	})
	if (!props.disableContextMenu) RC.setMenuTarget(button, { kind: 'player', playerId }, props.matchId)

	const showTeam = !!props.showTeam && player.teamId !== null && props.matchId !== undefined && props.matchId !== null
	const showSquad = !!props.showSquad && player.squadId !== null

	return Dom.el(
		'span',
		{ class: cn('inline-flex items-baseline', props.className) },
		player.isAdmin &&
			RC.setAdminBadge(
				Dom.el(
					'span',
					{ title: I18n.ambient.text(SM_Msgs.adminBadgeHint()), class: 'inline-block' },
					icon('ShieldCheck', 'h-[1em] w-[1em] text-background fill-admin'),
				),
				{ teamId: player.teamId, matchId: props.matchId },
			),
		player.isLeader &&
			Dom.el(
				'span',
				{ title: I18n.ambient.text(SM_Msgs.squadLeaderBadge()) },
				icon('Star', 'h-3 w-3 text-yellow-500 fill-yellow-500 shrink-0'),
			),
		button,
		(showTeam || showSquad) &&
			Dom.el(
				'span',
				{ class: 'inline-flex flex-nowrap' },
				'(',
				showTeam && matchTeamDisplay(ctx, { matchId: props.matchId, teamId: player.teamId! }),
				showTeam && showSquad && ', ',
				showSquad && `${player.squadId})`,
				!showSquad && ')',
			),
		props.showRole && player.role && Dom.el('span', { class: 'text-muted-foreground text-xs' }, `[${player.role}]`),
	)
}

export type SquadDisplayProps = {
	squad: Pick<SM.Squad, 'squadId' | 'squadName' | 'teamId'> & { uniqueId?: number }
	className?: string
	showName?: boolean
	showTeam?: boolean
	showMenu?: boolean
	matchId: number
}

export function squadDisplay(ctx: RC.RenderCtx, props: SquadDisplayProps): HTMLElement {
	const squad = props.squad
	const showName = props.showName ?? true
	const isDefaultName = squad.squadName === `Squad ${squad.squadId}`
	const label = isDefaultName ? `Squad ${squad.squadId}` : `Squad ${squad.squadId}${showName ? ` "${squad.squadName}"` : ''}`

	const squadLabel =
		squad.uniqueId !== undefined
			? RC.setWindowTarget(Dom.el('button', { type: 'button', class: 'hover:underline cursor-pointer font-bold' }, label), {
					windowId: WINDOW_ID.enum['squad-details'],
					arg: { uniqueSquadId: squad.uniqueId },
					frame: 'require',
					matchId: props.matchId,
					preload: true,
				})
			: Dom.el('span', { class: 'font-bold' }, label)

	if (props.showMenu ?? true) RC.setMenuTarget(squadLabel, { kind: 'squad', squad }, props.matchId)

	return Dom.el(
		'span',
		{ class: cn('inline-flex flex-nowrap items-center gap-1', props.className) },
		squadLabel,
		props.showTeam &&
			Dom.el(
				'span',
				{ class: 'inline-flex flex-nowrap' },
				'(',
				matchTeamDisplay(ctx, { matchId: props.matchId, teamId: squad.teamId }),
				')',
			),
	)
}

// -------- the row shell --------

const EVENT_LINE_CLASS = 'flex gap-2 py-1 text-xs text-muted-foreground w-full min-w-0 items-baseline'

/**
 * Shared layout for a feed entry: a non-shrinking time + icon gutter, then a text column that wraps.
 *
 * The text column has to stay a block rather than a flex row -- a flex row can't break between its items, which is
 * what pinned entries to a single line and forced the feed to scroll horizontally. Inline atoms keep themselves
 * intact via their own nowrap, so lines break between them rather than through them.
 *
 * wrap-anywhere rather than wrap-break-word: radix sizes the scroll viewport's content as a table, so the feed's
 * width follows its max-content width. Only `anywhere` shrinks an element's min-content contribution, so it's what
 * stops one long username or unbroken message from widening the whole feed.
 */
export function eventLine(time: number, iconElt: Dom.Child, body: Dom.Child, opts?: { className?: string; style?: string }): HTMLElement {
	return Dom.el(
		'div',
		{ class: opts?.className ? cn(EVENT_LINE_CLASS, opts.className) : EVENT_LINE_CLASS, style: opts?.style },
		eventTime(time),
		iconElt,
		Dom.el('div', { class: 'grow min-w-0 wrap-anywhere' }, body),
	)
}
