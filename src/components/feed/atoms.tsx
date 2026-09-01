// static-render calls these components directly, so the react compiler must not inject its memo-cache hook
'use no memo'

// The inline pieces a feed row is made of -- a player, a squad, a team, a layer, a timestamp -- as inert jsx:
// no hooks, no handlers, every interaction an attribute the delegated handlers read (see render-context.ts).
//
// These are the single implementation, rendered three ways: mounted directly where a react tree wants one
// piece (player-display.tsx and friends), rendered to strings client-side for the activity feed, and rendered
// to strings on the server for history results.

import React from 'react'

import * as DH from '@/lib/display-helpers'
import { withThrown } from '@/lib/error'
import * as Obj from '@/lib/object-utils'
import { isNullOrUndef } from '@/lib/type-guards'
import * as Typo from '@/lib/typography'
import { cn } from '@/lib/utils'
import * as I18n from '@/messages/i18n'
import * as L_Msgs from '@/messages/layer.messages'
import * as SM_Msgs from '@/messages/squad.messages'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import * as L from '@/models/layer'
import * as LQY from '@/models/layer-queries.models'
import type * as MH from '@/models/match-history.models'
import * as MHModels from '@/models/match-history.models'
import * as SM from '@/models/squad.models'

import { formatDateTime } from './format'
import { Icon } from './icons'
import * as RC from './render-context'

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

export function EventTime(props: { time: number }) {
	return (
		<button type="button" className="shrink-0" data-state="closed" {...{ [RC.TIP_TIME_ATTR]: props.time }}>
			<span className="text-muted-foreground font-mono text-xs whitespace-nowrap">
				{RC.usingFullTimestamps() ? formatDateTime(props.time) : shortTime(props.time)}
			</span>
		</button>
	)
}

// -------- layers --------

export function MapLayerDisplay(props: { layer: string; extraStyles?: Record<string, string | undefined>; className?: string }) {
	const styles = props.extraStyles ?? {}
	let segments = L.parseLayerStringSegment(props.layer)
	if (segments) segments = L.applyBackwardsCompatMappings(segments)
	if (!segments || segments.Gamemode === 'Training') return segments?.Map ?? props.layer
	const collection = segments.Collection ? L.StaticLayerComponents.collectionAbbreviations[segments.Collection] : null
	return (
		<span className={cn(styles.Layer, styles.Size, props.className)}>
			<span className={styles.Map}>{segments.Map}</span>
			{segments.Gamemode && (
				<>
					_<span className={styles.Gamemode}>{segments.Gamemode}</span>
				</>
			)}
			{segments.LayerVersion && (
				<>
					_<span className={styles.Layer}>{segments.LayerVersion.toLowerCase()}</span>
				</>
			)}
			{segments.Collection && collection !== null && (
				<>
					_<span className={styles.Collection}>{collection}</span>
				</>
			)}
		</span>
	)
}

// -------- teams --------

const TEAM_NAME_COLOR = '--team-name-color'
const trTeamName = I18n.ambient.withTags({
	team: (chunks) => (
		<span className="font-semibold" style={{ color: `var(${TEAM_NAME_COLOR})` }}>
			{chunks}
		</span>
	),
})

export function TeamIndicator(props: { team: MH.NormedTeamId | SM.TeamId }) {
	return (
		<span className="font-mono text" style={{ color: DH.TEAM_COLORS[`team${props.team}`] }}>
			({props.team})
		</span>
	)
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

export function TeamFactionDisplay(props: TeamFactionProps) {
	const displayTeamsNormalized = props.normalized
	const [partialLayer, error] = withThrown(() => (typeof props.layer === 'string' ? L.toLayer(props.layer) : props.layer))

	if (error || !partialLayer) {
		const layerId = typeof props.layer === 'string' ? props.layer : props.layer.id
		return (
			<span
				className="inline-block whitespace-nowrap text-destructive cursor-help"
				{...{
					[RC.TIP_HEADING_ATTR]: I18n.ambient.text(SM_Msgs.failedToParseLayer()),
					[RC.TIP_ATTR]: error instanceof Error ? error.message : 'Unknown error',
				}}
			>
				{layerId}
			</span>
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

	const factionElt = (
		<span className={cn(props.extraStyles?.[allianceProp], props.extraStyles?.[factionProp])}>
			{props.leadWithTeamName ? trTeamName.richText(L_Msgs.teamName(attrs[0].id, faction, true)) : faction}
		</span>
	)

	return (
		<span className={cn('inline-block whitespace-nowrap', props.className)}>
			<span
				title={attrs[0].title}
				style={props.leadWithTeamName ? ({ [TEAM_NAME_COLOR]: attrs[0].color } as React.CSSProperties) : { color: attrs[0].color }}
				className={props.leadWithTeamName ? 'font-normal text-muted-foreground' : 'font-semibold'}
			>
				{factionElt}
				{props.includeUnits && shortUnit && <span className={props.extraStyles?.[unitProp]}> {shortUnit}</span>}
				{props.showAltTeamIndicator && <TeamIndicator team={attrs[1].id} />}
			</span>
		</span>
	)
}

function teamsDisplayPair(
	layer: L.UnvalidatedLayer | L.LayerId,
	teamParity: number | undefined,
	displayLayersNormalized: boolean,
	extraStyles?: Record<keyof L.KnownLayer, string | undefined>,
	includeUnits = true,
): [React.ReactNode, React.ReactNode] {
	const parity = teamParity ?? 0
	const [left, right] = MHModels.getDisplayedTeamOrder(parity, displayLayersNormalized).map((normedTeam) => (
		<TeamFactionDisplay
			key={normedTeam}
			parity={parity}
			includeUnits={includeUnits}
			layer={layer}
			team={MHModels.getDenormedTeamId(normedTeam, parity)}
			showAltTeamIndicator={true}
			normalized={displayLayersNormalized}
			extraStyles={extraStyles}
		/>
	))
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

export function MatchTeamDisplay(props: MatchTeamProps & { ctx: RC.RenderCtx }) {
	const { ctx } = props
	let match: MH.MatchDetails | undefined
	if (props.matchId === undefined || props.matchId === null) {
		match = ctx.latestMatch
		if (!match?.isCurrentMatch) return null
	} else {
		match = ctx.matchById(props.matchId)
	}
	if (!match) return null
	return (
		<TeamFactionDisplay
			normalized={ctx.displayTeamsNormalized}
			className={props.className}
			parity={match.ordinal}
			team={MHModels.getDenormedTeamId(props.teamId, match.ordinal)}
			layer={match.layerId}
			includeUnits={props.includeUnits}
			showAltTeamIndicator={props.showAltTeamIndicator}
			leadWithTeamName={props.leadWithTeamName}
		/>
	)
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

export function ShortLayerNameContent(props: ShortLayerNameProps) {
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

	if (!partialLayer.Layer) return <>{props.layerId.slice('RAW:'.length)}</>

	const backfilled = { ...(backfillLayer ?? {}), ...partialLayer }
	const hasFactions = !!backfilled.Faction_1 && !!backfilled.Faction_2
	const [leftTeamElt, rightTeamElt] = hasFactions
		? teamsDisplayPair(backfilled, props.teamParity ?? 0, props.normalized, extraStyles)
		: [null, null]

	return (
		<>
			{backfilled.Layer && <MapLayerDisplay layer={backfilled.Layer} extraStyles={extraStyles} />}
			{hasFactions && (
				<>
					<Icon name="Dot" className="self-center" />
					{leftTeamElt}
					<span className="mx-1">{I18n.ambient.text(L_Msgs.versus())}</span>
					{rightTeamElt}
				</>
			)}
		</>
	)
}

/** Opens the layer info window. The react ShortLayerName wraps the same content in an OpenWindowInteraction. */
export function LayerInfoButton(props: { layerId: L.LayerId; children: React.ReactNode }) {
	return (
		<button
			type="button"
			className="text-primary underline-offset-4 [&:hover>span]:underline"
			{...RC.windowAttrs({ windowId: WINDOW_ID.enum['layer-info'], arg: { layerId: props.layerId }, preload: true })}
		>
			{props.children}
		</button>
	)
}

/**
 * A layer's name, as the feed draws it.
 *
 * flex-wrap so a long "Map_Gamemode_v1 . FactionA vs FactionB" can break across lines in a narrow container; each
 * segment stays intact because it carries its own nowrap.
 */
export function ShortLayerName(props: ShortLayerNameProps) {
	const span = (
		<span data-tour={props.tourId} className={cn('inline-flex flex-wrap items-baseline', props.className)}>
			<ShortLayerNameContent {...props} />
		</span>
	)
	if ((props.allowShowInfo ?? true) && L.isKnownLayer(props.layerId))
		return <LayerInfoButton layerId={props.layerId}>{span}</LayerInfoButton>
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

export function PlayerDisplay(props: PlayerDisplayProps & { ctx: RC.RenderCtx }) {
	const { ctx, player } = props
	const playerId = SM.PlayerIds.getPlayerId(player.ids)
	const groupColor = ctx.groupColor(playerId, player)

	const showTeam = !!props.showTeam && player.teamId !== null && props.matchId !== undefined && props.matchId !== null
	const showSquad = !!props.showSquad && player.squadId !== null

	return (
		<span className={cn('inline-flex items-baseline', props.className)}>
			{player.isAdmin && (
				<span
					title={I18n.ambient.text(SM_Msgs.adminBadgeHint())}
					className="inline-block"
					{...RC.adminBadgeAttrs({ teamId: player.teamId, matchId: props.matchId })}
				>
					<Icon name="ShieldCheck" className="h-[1em] w-[1em] text-background fill-admin" />
				</span>
			)}
			{player.isLeader && (
				<span title={I18n.ambient.text(SM_Msgs.squadLeaderBadge())}>
					<Icon name="Star" className="h-3 w-3 text-yellow-500 fill-yellow-500 shrink-0" />
				</span>
			)}
			<button
				type="button"
				className="font-bold hover:underline cursor-pointer"
				style={groupColor ? { color: groupColor } : undefined}
				{...RC.colourAttrs(playerId)}
				{...RC.windowAttrs({
					// frame 'attach', not 'require': the window renders what it can without a live server behind it
					windowId: WINDOW_ID.enum['player-details'],
					arg: { playerId },
					frame: 'attach',
					matchId: props.matchId,
					preload: true,
				})}
				{...(props.disableContextMenu ? {} : RC.menuAttrs({ kind: 'player', playerId }, props.matchId))}
			>
				{player.ids.username}
			</button>
			{(showTeam || showSquad) && (
				<span className="inline-flex flex-nowrap">
					({showTeam && <MatchTeamDisplay ctx={ctx} matchId={props.matchId} teamId={player.teamId!} />}
					{showTeam && showSquad && ', '}
					{showSquad && `${player.squadId})`}
					{!showSquad && ')'}
				</span>
			)}
			{props.showRole && player.role && <span className="text-muted-foreground text-xs">[{player.role}]</span>}
		</span>
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

export function SquadDisplay(props: SquadDisplayProps & { ctx: RC.RenderCtx }) {
	const { ctx, squad } = props
	const showName = props.showName ?? true
	const isDefaultName = squad.squadName === `Squad ${squad.squadId}`
	const label = isDefaultName ? `Squad ${squad.squadId}` : `Squad ${squad.squadId}${showName ? ` "${squad.squadName}"` : ''}`
	const menuAttrs = (props.showMenu ?? true) ? RC.menuAttrs({ kind: 'squad', squad }, props.matchId) : {}

	const squadLabel =
		squad.uniqueId !== undefined ? (
			<button
				type="button"
				className="hover:underline cursor-pointer font-bold"
				{...RC.windowAttrs({
					windowId: WINDOW_ID.enum['squad-details'],
					arg: { uniqueSquadId: squad.uniqueId },
					frame: 'require',
					matchId: props.matchId,
					preload: true,
				})}
				{...menuAttrs}
			>
				{label}
			</button>
		) : (
			<span className="font-bold" {...menuAttrs}>
				{label}
			</span>
		)

	return (
		<span className={cn('inline-flex flex-nowrap items-center gap-1', props.className)}>
			{squadLabel}
			{props.showTeam && (
				<span className="inline-flex flex-nowrap">
					(
					<MatchTeamDisplay ctx={ctx} matchId={props.matchId} teamId={squad.teamId} />)
				</span>
			)}
		</span>
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
export function EventLine(props: {
	time: number
	icon: React.ReactNode
	className?: string
	style?: React.CSSProperties
	children: React.ReactNode
}) {
	return (
		<div className={props.className ? cn(EVENT_LINE_CLASS, props.className) : EVENT_LINE_CLASS} style={props.style}>
			<EventTime time={props.time} />
			{props.icon}
			<div className="grow min-w-0 wrap-anywhere">{props.children}</div>
		</div>
	)
}
