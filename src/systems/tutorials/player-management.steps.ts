import React from 'react'
import { flushSync } from 'react-dom'

import * as Selection from '@/components/feed/selection'
import * as ChatPrt from '@/frame-partials/chat.partial'
import * as TeamsPanelPrt from '@/frame-partials/teams-panel.partial'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import * as Zus from '@/lib/zustand'
import * as CMD_Msgs from '@/messages/command.messages'
import * as PMTUT_Msgs from '@/messages/tutorials/player-management-tutorial.messages'
import * as CMDH from '@/models/command-help.models'
import * as CMD from '@/models/command.models'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import * as MH from '@/models/match-history.models'
import * as PG from '@/models/player-groupings.models'
import * as SM from '@/models/squad.models'
import * as TUT from '@/models/tutorial.models'
import * as UP from '@/models/user-presence.models'
import * as RPC from '@/orpc.client'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import * as ClientOnlySettings from '@/systems/client-only-settings.client'
import * as ConfigClient from '@/systems/config.client'
import { DraggableWindowStore, openOrFocusWindow } from '@/systems/draggable-window.client'
import { tr } from '@/systems/messages.client'
import * as SettingsClient from '@/systems/settings.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as SRQClient from '@/systems/switch-requests.client'
import * as TSWClient from '@/systems/teamswaps.client'
import * as TimeoutsClient from '@/systems/timeouts.client'
import * as Tour from '@/systems/tour.client'
import * as UPClient from '@/systems/user-presence.client'

// The client half of the player management tutorial. The order is the curriculum: the server activity log, then
// finding the players, reading them and acting on them, from the lightest action to the ones that move people
// between teams. The copy is in
// @/messages/tutorials/player-management-tutorial.messages, and the roster and its targets are TUT.PM_TUTORIAL_*.
// Importing this file registers the scenario.
//
// Every section that acts on the roster starts at a cp-roster checkpoint, which undoes what the earlier sections
// did to it (kicks, timeouts, moves, swaps, switch requests), so a jump into one replays nothing from another.

const TARGETS = TUT.PM_TUTORIAL_TARGETS
const ROSTER = TUT.PM_TUTORIAL_ROSTER
const TIMEOUT_DURATION_MS = 15 * 60 * 1000
const READY_TIMEOUT_MS = 5000

// ============================== reading the run ==============================

const players = (s: any): SM.Player[] => ChatPrt.Sel.players(s)
const playerNamed = (s: any, name: string) => players(s).find((p) => p.ids.username === name)
const playerIdNamed = (s: any, name: string) => {
	const player = playerNamed(s, name)
	return player ? SM.PlayerIds.getPlayerId(player.ids) : undefined
}

function laidOut(selector: string) {
	return [...document.querySelectorAll(selector)].some((el) => el.getClientRects().length > 0)
}

function domPresent(target: Tour.AnchorTarget, present = true): Tour.StateSelector<boolean> {
	return {
		inputs: () => [Tour.domInput(Tour.anchorSelector(target))],
		select: (els: Element[]) => els.some((el) => el.getClientRects().length > 0) === present,
	}
}

const row = (name: string): Tour.AnchorTarget => ({ css: `[data-tour="teams-panel"] [data-tour="player-row"][data-tour-player="${name}"]` })
const squadHeader = (squad: string): Tour.AnchorTarget => ({
	css: `[data-tour="teams-panel"] [data-tour="squad-header"][data-tour-squad="${squad}"]`,
})
const closeControl = (windowTourId: string): Tour.AnchorTarget => ({
	css: `[data-tour="${windowTourId}"] [data-window-control="close"]`,
})

const TEAMS_TAB_SELECTED = '[data-tour="primary-tab-teams"][aria-selected="true"]'
const teamsShown = domPresent('teams-panel')

const teamsTabSelected: Tour.StateSelector<boolean> = {
	inputs: () => [Tour.domInput(TEAMS_TAB_SELECTED)],
	select: (els: Element[]) => els.some((el) => el.getClientRects().length > 0),
}

function editingTeamswaps(serverId: string, upState: any): boolean {
	const clientId = ConfigClient.getConfig()?.wsClientId
	const activity = clientId ? upState.presence.get(clientId)?.activityState : null
	return !!activity && UP.Trans.editingTeamswaps(serverId).match(activity)
}

const rosterSettled: Tour.StateSelector<boolean> = {
	inputs: (run) => [run.squadServer],
	select: (s: any) =>
		ROSTER.every((spec) => playerNamed(s, spec.name)?.teamId === spec.team) &&
		SRQClient.Sel.requestCount(s) === 0 &&
		TSWClient.Sel.localState(s).savedSwaps.size === 0,
}

const CP_ROSTER: Tour.Checkpoint = { stage: 'cp-roster', ready: rosterSettled }

// ============================== commands ==============================

// A command as the reader would type it, linked to its entry on the commands page, with the install's own triggers
// and its one-line description. Null when the install has it turned off, so a card never offers a dead command.
function commandItem(settings: any, id: CMD.CommandId): React.ReactNode | null {
	const config: CMD.CommandConfig | undefined = settings?.commands?.[id]
	if (!config?.enabled) return null
	const primary = CMD.primaryTrigger(config)
	if (!primary) return null
	const usage = CMD.formatTriggerUsage(id, primary, settings.requireReasonFor ?? [])
	const aliases = config.triggers.filter((t) => typeof t === 'string' && t !== primary).map(CMD.triggerString)
	const link = React.createElement(
		'a',
		{
			href: `/commands#${encodeURIComponent(CMDH.commandsPageAnchor(id))}`,
			target: '_blank',
			rel: 'noopener noreferrer',
			className: 'underline',
		},
		React.createElement('code', null, usage),
	)
	const aliasNodes = aliases.flatMap((alias) => [', ', React.createElement('code', { key: alias }, alias)])
	return React.createElement(React.Fragment, null, link, ...aliasNodes)
}

function commandList(settings: any, ids: CMD.CommandId[]): React.ReactNode | null {
	const items = ids.flatMap((id) => {
		const item = commandItem(settings, id)
		if (!item) return []
		return [React.createElement('li', { key: id }, item, ': ', tr.text(CMD_Msgs.descriptions[id]))]
	})
	return items.length > 0 ? React.createElement('ul', null, ...items) : null
}

function hasAnyCommand(ids: CMD.CommandId[]) {
	const settings = Zus.getState(SettingsClient.PublicSettingsStore) as any
	return ids.some((id) => settings?.commands?.[id]?.enabled)
}

// a card whose body lists the given commands, re-rendered if the install's command config changes mid-run
function withCommands(
	msg: { title: () => any; body: (commands: React.ReactNode) => any },
	ids: CMD.CommandId[],
): Tour.StateSelector<Tour.RenderedStep> {
	return {
		inputs: () => [SettingsClient.PublicSettingsStore],
		select: (settings: any) => ({ title: tr.text(msg.title()), body: Tour.richText(msg.body(commandList(settings, ids))) }),
	}
}

const WARN_COMMANDS: CMD.CommandId[] = ['warn', 'listWarnReasons']
const SQUAD_COMMANDS: CMD.CommandId[] = ['warnSquad', 'kickSquad', 'timeoutSquad', 'swapSquadNow', 'swapSquadNext']
const KICK_COMMANDS: CMD.CommandId[] = ['kick']
const TIMEOUT_COMMANDS: CMD.CommandId[] = ['timeout', 'clearTimeout']
const SWAP_NOW_COMMANDS: CMD.CommandId[] = ['swapNow']
const TEAMSWAP_COMMANDS: CMD.CommandId[] = ['swapNext', 'swaps', 'clearSwaps']
const OTHER_COMMANDS: CMD.CommandId[] = ['kill', 'removeFromSquad', 'disbandSquad', 'demoteCommander', 'flag', 'removeFlag', 'listFlags']
const SWITCH_COMMANDS: CMD.CommandId[] = ['requestSwitch', 'cancelSwitch']

// ============================== groupings ==============================

// The grouping the tour narrates, and a group in it to click. An install can have no groupings, or only ones that
// read BattleMetrics flags or discord roles the sandbox players cannot have, in which case every player is Other
// and the steps about clicking a group have nothing to show. So the tour picks the first grouping that splits the
// roster into at least two groups, preferring the one a fresh install ships with, and leaves those steps out when
// there is none.
type GroupingPlan = { ids: string[]; groupingId: string | null; group: string | null; unmatched: boolean }

function planGroupings(): GroupingPlan {
	const settings = Zus.getState(SettingsClient.PublicSettingsStore) as any
	const groupings: PG.PlayerGroupings = settings?.playerGroupings ?? {}
	const ids = PG.getGroupingIds(groupings)
	const ordered = [...ids].sort((a, b) => Number(b === PG.SEEDED_GROUPING_ID) - Number(a === PG.SEEDED_GROUPING_ID))
	for (const groupingId of ordered) {
		const grouping = groupings[groupingId]
		const counts = new Map<string, number>()
		for (const spec of ROSTER) {
			const facts = PG.playerFacts(
				{ ids: { username: spec.name }, isAdmin: spec.groups.includes('Admin'), adminGroups: spec.groups },
				[],
			)
			const group = PG.resolveGroup(grouping, facts)
			if (group !== undefined) counts.set(group, (counts.get(group) ?? 0) + 1)
		}
		if (counts.size < 2) continue
		const [group] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
		const unmatched = PG.getGroupNames(grouping).some((name) => !counts.has(name))
		return { ids, groupingId, group, unmatched }
	}
	return { ids, groupingId: null, group: null, unmatched: false }
}

// ============================== simulates ==============================
// The programmatic equivalents of what each transition waits for. Server actions go through the same RPCs the
// dashboard's own menus call, and each waits for its result to reach the client before the jump moves on.

function stores(run: Tour.RunStores): SquadServerFrame.KeyProp {
	return { squadServer: run.squadServer }
}

function panelStores(run: Tour.RunStores): TeamsPanelPrt.KeyProp {
	return { teamsPanel: run.squadServer }
}

// the search box is uncontrolled, so resetting the store leaves its text behind unless it is cleared too
function clearSearchInput() {
	const input = document.querySelector<HTMLInputElement>('input[data-tour="teams-search"]')
	if (input) input.value = ''
}

function simResetPanel(ctx: Tour.SimulateCtx) {
	SquadServerFrame.Actions.resetTeamsPanel(stores(ctx.run))
	clearSearchInput()
}

// The teams panel is behind a tab in some layouts, and the dashboard can switch layouts under the reader. A step
// narrating the teams brings them back rather than walking the tour back to where they were first opened.
// Returns whether the teams were already on screen: rows are not laid out in the same frame they are shown, so a
// caller checking one right after bringing the teams back would misread it as hidden by something else.
function ensureTeamsShown(): boolean {
	if (laidOut('[data-tour="teams-panel"]')) return true
	SquadServerClient.PrimaryPanelActions.showTeams()
	return false
}

// The breakdown steps point at the Charts panel's Teams chart, which the reader may have switched away from.
function ensureTeamsChartShown() {
	if (ClientOnlySettings.Sel.chartsTab(ClientOnlySettings.Store.getState()) !== 'teams') ClientOnlySettings.Actions.setChartsTab('teams')
}

// A step pointing at a player's row needs the row on screen, and the reader may have collapsed its squad, searched
// for someone else or narrowed the table to their selection since. Only acts when the row is hidden.
function revealPlayer(run: Tour.RunStores, name: string) {
	if (!ensureTeamsShown()) return
	const target = row(name) as { css: string }
	if (laidOut(target.css)) return
	const s = Zus.getState(run.squadServer) as any
	const player = playerNamed(s, name)
	if (!player) return
	const panel = panelStores(run)
	TeamsPanelPrt.Actions.reset(panel)
	TeamsPanelPrt.Actions.setShowSelected(panel, false)
	clearSearchInput()
	if (player.teamId === null) return
	const key = TeamsPanelPrt.squadGroupKey(normedTeamOf(run, player.teamId), player.squadId)
	if (TeamsPanelPrt.Sel.isSquadCollapsed(TeamsPanelPrt.Sel.squadCollapse(s), key)) {
		TeamsPanelPrt.Actions.toggleSquadCollapsed(panel, key)
	}
}

// Squad header rows only exist while the table is sorted by squad, and a search, filter or Show Selected can leave a
// squad with no rows to head. Only acts when the header is hidden.
function revealSquadHeader(run: Tour.RunStores, squad: string) {
	if (!ensureTeamsShown()) return
	if (laidOut((squadHeader(squad) as { css: string }).css)) return
	const panel = panelStores(run)
	TeamsPanelPrt.Actions.reset(panel)
	TeamsPanelPrt.Actions.setShowSelected(panel, false)
	clearSearchInput()
}

// the finished match just before the one being played, which the match history steps read their examples off
const PAST_MATCH_ROW_CSS = '[data-tour="mh-row"]:has(+ [data-tour-current])'
const PAST_MATCH_ROW: Tour.AnchorTarget = { css: PAST_MATCH_ROW_CSS }
const pastMatchCell = (tourId: string): Tour.AnchorTarget => ({ css: `${PAST_MATCH_ROW_CSS} [data-tour="${tourId}"]` })

const viewingPastMatch: Tour.StateSelector<boolean> = {
	inputs: (run) => [run.squadServer],
	select: (s: any) => s.chat.selectedMatchOrdinal !== null,
}

// the most recent finished match, the one a reader clicking the top of the list of past matches would open
function simViewPastMatch(ctx: Tour.SimulateCtx) {
	const match = ctx.run.currentMatch.getValue()
	const ordinal = match && 'ordinal' in match ? match.ordinal : null
	if (ordinal === null || ordinal === 0) return
	void ChatPrt.Actions.setSelectedMatchOrdinal({ chat: ctx.run.squadServer }, ordinal - 1)
}

function simShowTeams() {
	SquadServerClient.PrimaryPanelActions.showTeams()
}

function normedTeamOf(run: Tour.RunStores, teamId: SM.TeamId): MH.NormedTeamId {
	const match = run.currentMatch.getValue()
	const ordinal = match && 'ordinal' in match ? match.ordinal : 0
	return MH.getNormedTeamId(teamId, ordinal)
}

function squadIdNamed(run: Tour.RunStores, teamId: SM.TeamId, name: string): number | undefined {
	return (ChatPrt.Sel.squads(Zus.getState(run.squadServer)) as SM.Squad[]).find((sq) => sq.teamId === teamId && sq.squadName === name)
		?.squadId
}

const FILTER_SQUAD = { team: 1 as const, name: 'ALPHA' }

function simFilterSquad(ctx: Tour.SimulateCtx) {
	const squadId = squadIdNamed(ctx.run, FILTER_SQUAD.team, FILTER_SQUAD.name)
	if (squadId === undefined) return
	TeamsPanelPrt.Actions.setSquadFilter(panelStores(ctx.run), normedTeamOf(ctx.run, FILTER_SQUAD.team), String(squadId))
}

function simClearFilters(ctx: Tour.SimulateCtx) {
	const panel = panelStores(ctx.run)
	TeamsPanelPrt.Actions.setGroupFilter(panel, null)
	TeamsPanelPrt.Actions.setRoleFilter(panel, null)
	for (const target of ['A', 'B', 'combined'] as const) TeamsPanelPrt.Actions.setSquadFilter(panel, target, null)
}

const noColumnFilters: Tour.StateSelector<boolean> = {
	inputs: (run) => [run.squadServer],
	select: (s: any) => {
		const panel = s.teamsPanel
		return panel.groupFilter === null && panel.roleFilter === null && Object.values(panel.squadFilters).every((v) => v === null)
	},
}

function simSelect(ctx: Tour.SimulateCtx, names: string[]) {
	const s = Zus.getState(ctx.run.squadServer)
	const ids = names.map((name) => playerIdNamed(s, name)).filter((id): id is SM.PlayerId => !!id)
	SquadServerFrame.Actions.selectPlayerIds(stores(ctx.run), ids)
}

async function simOpenPlayerDetails(ctx: Tour.SimulateCtx, name: string) {
	const playerId = playerIdNamed(Zus.getState(ctx.run.squadServer), name)
	if (!playerId) return
	await import('@/components/player-details-window')
	if (ctx.signal.aborted) return
	flushSync(() => openOrFocusWindow(WINDOW_ID.enum['player-details'], { playerId, stores: stores(ctx.run) }))
	await Tour.awaitSelector(ctx.run, domPresent('player-details-window'), ctx.signal, READY_TIMEOUT_MS)
}

function closeWindows(type: string) {
	const store = DraggableWindowStore.getState()
	for (const w of store.windows.filter((w) => w.type === type)) store.closeWindow(w.id)
}

async function simKick(ctx: Tour.SimulateCtx) {
	const playerId = playerIdNamed(Zus.getState(ctx.run.squadServer), TARGETS.kick)
	if (!playerId) return
	await RPC.orpc.squadServer.kickPlayers.call({ serverId: ctx.run.serverId, playerIds: [playerId], reason: 'Tutorial' })
	await Tour.awaitSelector(ctx.run, kicked, ctx.signal, READY_TIMEOUT_MS)
}

const kicked: Tour.StateSelector<boolean> = {
	inputs: (run) => [run.squadServer],
	select: (s: any) => !playerNamed(s, TARGETS.kick),
}

const timedOut: Tour.StateSelector<boolean> = {
	inputs: () => [TimeoutsClient.activeTimeouts$],
	select: (timeouts: any[]) => timeouts.some((t) => t.username === TARGETS.timeout && !t.cancelled),
}

const timeoutCancelled: Tour.StateSelector<boolean> = {
	inputs: () => [TimeoutsClient.activeTimeouts$],
	select: (timeouts: any[]) => !timedOut.select(timeouts),
}

async function simTimeout(ctx: Tour.SimulateCtx) {
	const playerId = playerIdNamed(Zus.getState(ctx.run.squadServer), TARGETS.timeout)
	if (!playerId) return
	await RPC.orpc.timeouts.timeoutPlayer.call({
		serverId: ctx.run.serverId,
		playerId,
		durationMs: TIMEOUT_DURATION_MS,
		reason: 'Tutorial',
	})
	await Tour.awaitSelector(ctx.run, timedOut, ctx.signal, READY_TIMEOUT_MS)
}

async function simCancelTimeout(ctx: Tour.SimulateCtx) {
	const timeouts = TimeoutsClient.activeTimeouts$.getValue() as any[]
	for (const t of timeouts.filter((t) => t.username === TARGETS.timeout && !t.cancelled)) {
		await RPC.orpc.timeouts.cancelTimeout.call({ timeoutId: t.id })
	}
	await Tour.awaitSelector(ctx.run, timeoutCancelled, ctx.signal, READY_TIMEOUT_MS)
}

async function simOpenTimeouts(ctx: Tour.SimulateCtx) {
	await import('@/components/timeouts-window')
	if (ctx.signal.aborted) return
	flushSync(() => openOrFocusWindow(WINDOW_ID.enum['timeouts'], {}))
}

const swappedNow: Tour.StateSelector<boolean> = {
	inputs: (run) => [run.squadServer],
	select: (s: any) => {
		const spec = ROSTER.find((p) => p.name === TARGETS.swapNow)!
		const player = playerNamed(s, TARGETS.swapNow)
		return !!player && player.teamId !== spec.team
	},
}

async function simSwapNow(ctx: Tour.SimulateCtx) {
	const playerId = playerIdNamed(Zus.getState(ctx.run.squadServer), TARGETS.swapNow)
	if (!playerId) return
	TSWClient.Actions.swapNow(stores(ctx.run), [playerId])
	await Tour.awaitSelector(ctx.run, swappedNow, ctx.signal, READY_TIMEOUT_MS)
}

const swapNextQueued: Tour.StateSelector<boolean> = {
	inputs: (run) => [run.squadServer],
	select: (s: any) => {
		const playerId = playerIdNamed(s, TARGETS.swapNext)
		return !!playerId && TSWClient.Sel.localState(s).editedSwaps.has(playerId)
	},
}

async function simSwapNext(ctx: Tour.SimulateCtx) {
	const playerId = playerIdNamed(Zus.getState(ctx.run.squadServer), TARGETS.swapNext)
	if (!playerId) return
	TSWClient.Actions.swapNext(stores(ctx.run), [playerId])
	await Tour.awaitSelector(ctx.run, domPresent('swaps-panel'), ctx.signal, READY_TIMEOUT_MS)
}

function simSaveSwaps(ctx: Tour.SimulateCtx) {
	if (TSWClient.Sel.swapsModified(Zus.getState(ctx.run.squadServer))) TSWClient.Actions.save(stores(ctx.run))
	if (editingTeamswaps(ctx.run.serverId, UPClient.Store.getState())) {
		UPClient.Actions.updateActivity(UP.Trans.editingTeamswaps(ctx.run.serverId).destroy())
	}
}

async function simOpenSwitchRequests(ctx: Tour.SimulateCtx) {
	await import('@/components/switch-requests-window')
	if (ctx.signal.aborted) return
	flushSync(() => openOrFocusWindow(WINDOW_ID.enum['switch-requests'], { stores: stores(ctx.run) }))
}

const switchRequested: Tour.StateSelector<boolean> = {
	inputs: (run) => [run.squadServer],
	select: (s: any) => SRQClient.Sel.requestCount(s) > 0,
}

const switchQueueEmpty: Tour.StateSelector<boolean> = {
	inputs: (run) => [run.squadServer],
	select: (s: any) => SRQClient.Sel.requestCount(s) === 0,
}

async function simSwitchNow(ctx: Tour.SimulateCtx) {
	for (const request of SRQClient.Sel.requests(Zus.getState(ctx.run.squadServer))) {
		await SRQClient.Actions.switchNow(stores(ctx.run), request.playerId)
	}
	await Tour.awaitSelector(ctx.run, switchQueueEmpty, ctx.signal, READY_TIMEOUT_MS)
}

// the activity feed's selectable host, and the selection it holds
function feedHost(): Element | null {
	return document.querySelector(`[data-tour="activity-feed"] [data-dom-selectable]`)
}

const feedSelected: Tour.StateSelector<boolean> = {
	inputs: () => [Selection.SelectionStore],
	select: () => {
		const host = feedHost()
		const key = host && Selection.keyOf(host)
		return !!key && !!Selection.get(key)
	},
}

function simSelectFeedRows() {
	const host = feedHost()
	const key = host && Selection.keyOf(host)
	if (!host || !key) return
	const rows = [...host.querySelectorAll('[data-dom-row]')]
	if (rows.length === 0) return
	const anchor = rows[Math.max(0, rows.length - 3)].getAttribute('data-dom-row')!
	const head = rows[rows.length - 1].getAttribute('data-dom-row')!
	Selection.set(key, { anchor, head })
}

// Closes every window the tour opens, puts the queue tab back, and returns the teams panel and the feed to their
// defaults. The grouping is set to the one the tour narrates, when there is one to pick.
function resetClient(run: Tour.RunStores, plan: GroupingPlan) {
	const store = DraggableWindowStore.getState()
	for (const w of [...store.windows]) store.closeWindow(w.id)
	SquadServerFrame.Actions.resetTeamsPanel(stores(run))
	TeamsPanelPrt.Actions.setShowSpoilers(panelStores(run), false)
	clearSearchInput()
	const host = feedHost()
	const key = host && Selection.keyOf(host)
	if (key) Selection.set(key, undefined)
	void ChatPrt.Actions.setSelectedMatchOrdinal({ chat: run.squadServer }, null)
	if (plan.groupingId) BattlemetricsClient.Actions.setSelectedGroupingId(plan.groupingId)
	SquadServerClient.PrimaryPanelActions.touchStackedSection('VIEWING_QUEUE')
	// the tab is a persisted preference, and the first card asks the reader to open the teams from the queue
	ClientOnlySettings.Actions.setPrimaryPanelTab('VIEWING_QUEUE')
}

// ============================== steps ==============================

export function buildSteps(plan: GroupingPlan) {
	const settings = Zus.getState(SettingsClient.PublicSettingsStore) as any
	const warnPresets = (settings?.adminActionReasons ?? []).some((r: any) => !r.actions || r.actions.includes('warn'))
	const switchEnabled = !!settings?.commands?.requestSwitch?.enabled
	const groupStepsPossible = plan.groupingId !== null && plan.group !== null

	const inGame = (id: string, msg: Parameters<typeof withCommands>[0], ids: CMD.CommandId[], extra?: Partial<Tour.Step>) =>
		hasAnyCommand(ids) ? [{ id, msg: withCommands(msg, ids), ...extra } as Tour.Step] : []

	return Tour.defineSteps([
		{ id: 'welcome', msg: PMTUT_Msgs.welcome, checkpoint: CP_ROSTER },

		// the server activity log, and the box under it for messaging the server
		{ id: 'activity-panel', anchor: 'activity-panel', msg: PMTUT_Msgs.Activity.panel },
		{ id: 'activity-filter', anchor: 'activity-filter', spotlight: 'activity-panel', interact: 'free', msg: PMTUT_Msgs.Activity.filter },
		{ id: 'activity-select', anchor: 'activity-feed', interact: 'free', msg: PMTUT_Msgs.Activity.select },
		{
			id: 'activity-copy',
			anchor: 'activity-feed',
			interact: 'free',
			msg: PMTUT_Msgs.Activity.copy,
			advanceFromPrevious: { type: 'state', ...feedSelected, simulate: simSelectFeedRows },
		},
		{ id: 'activity-warn', anchor: 'activity-warn', spotlight: 'activity-panel', interact: 'free', msg: PMTUT_Msgs.Activity.warnBox },

		// the match history, and looking back at a match through it
		{ id: 'mh-overview', anchor: { all: 'match-history' }, msg: PMTUT_Msgs.MatchHistory.overview },
		{
			id: 'mh-time',
			anchor: pastMatchCell('mh-time'),
			spotlight: { all: 'match-history' },
			interact: 'anchor-only',
			msg: PMTUT_Msgs.MatchHistory.time,
		},
		{ id: 'mh-outcome', anchor: pastMatchCell('mh-outcome'), spotlight: { all: 'match-history' }, msg: PMTUT_Msgs.MatchHistory.outcome },
		{
			id: 'mh-kd',
			anchor: pastMatchCell('mh-kd'),
			spotlight: { all: 'match-history' },
			interact: 'anchor-only',
			msg: PMTUT_Msgs.MatchHistory.kd,
		},
		{
			id: 'mh-set-by',
			anchor: { css: '[data-tour="mh-row"] [data-tour="mh-set-by"]', all: true },
			spotlight: { all: 'match-history' },
			interact: 'anchor-only',
			msg: PMTUT_Msgs.MatchHistory.setBy,
		},
		{ id: 'mh-open', anchor: PAST_MATCH_ROW, interact: 'anchor-only', msg: PMTUT_Msgs.MatchHistory.open },
		{
			id: 'mh-viewing',
			anchor: 'activity-panel',
			msg: PMTUT_Msgs.MatchHistory.viewing,
			premise: viewingPastMatch,
			advanceFromPrevious: { type: 'state', ...viewingPastMatch, simulate: simViewPastMatch },
		},
		{
			id: 'mh-arrows',
			anchor: 'activity-match-nav',
			spotlight: 'activity-panel',
			interact: 'free',
			msg: PMTUT_Msgs.MatchHistory.arrows,
			premise: viewingPastMatch,
		},
		{ id: 'mh-live', anchor: 'activity-live', interact: 'anchor-only', msg: PMTUT_Msgs.MatchHistory.live, premise: viewingPastMatch },
		{
			id: 'mh-days',
			anchor: 'mh-days',
			spotlight: { all: 'match-history' },
			interact: 'anchor-only',
			msg: PMTUT_Msgs.MatchHistory.days,
			advanceFromPrevious: {
				type: 'state',
				inputs: (run) => [run.squadServer],
				select: (s: any) => s.chat.selectedMatchOrdinal === null,
				simulate: (ctx) => void ChatPrt.Actions.setSelectedMatchOrdinal({ chat: ctx.run.squadServer }, null),
			},
		},

		// the players on the server
		{
			id: 'find-teams',
			anchor: () => (laidOut('[data-tour="primary-tab-teams"]') ? 'primary-tab-teams' : 'teams-panel'),
			interact: 'anchor-only',
			msg: {
				inputs: () => [Tour.domInput('[data-tour="primary-tab-teams"]')],
				select: (els: Element[]) => {
					const msg = els.some((el) => el.getClientRects().length > 0) ? PMTUT_Msgs.findTeamsTab : PMTUT_Msgs.findTeamsStacked
					return { title: tr.text(msg.title()), body: Tour.richText(msg.body()) }
				},
			},
		},
		{
			id: 'teams-header',
			anchor: 'teams-header',
			msg: PMTUT_Msgs.teamsHeader,
			premise: teamsShown,
			// in the stacked layout there is no tab, and the teams are already on screen
			advanceFromPrevious: { type: 'state', ...teamsTabSelected, allowNext: true, simulate: simShowTeams },
		},

		// groupings, and the breakdown built from them
		{
			id: 'groupings-column',
			anchor: 'players-col-group',
			spotlight: 'teams-panel',
			msg: PMTUT_Msgs.groupingsColumn,
			prepare: ensureTeamsShown,
		},
		...(plan.ids.length > 0
			? [
					{
						id: 'grouping-modes',
						anchor: 'teams-grouping',
						interact: 'free' as const,
						msg: PMTUT_Msgs.groupingModes,
						prepare: ensureTeamsShown,
					},
				]
			: []),
		{ id: 'breakdown', anchor: 'teams-breakdown', msg: PMTUT_Msgs.breakdown, prepare: ensureTeamsChartShown },
		{
			id: 'breakdown-hover',
			anchor: 'teams-breakdown-chart',
			interact: 'anchor-only',
			msg: PMTUT_Msgs.breakdownHover,
			prepare: ensureTeamsChartShown,
		},
		...(groupStepsPossible
			? [
					{
						id: 'breakdown-filter',
						anchor: 'teams-breakdown-chart',
						interact: 'anchor-only' as const,
						msg: { title: PMTUT_Msgs.breakdownFilter.title, body: () => PMTUT_Msgs.breakdownFilter.body(plan.group!) },
						prepare: ensureTeamsChartShown,
					},
					{
						id: 'breakdown-select',
						anchor: 'teams-breakdown-chart',
						spotlight: { css: '[data-tour="teams-breakdown"], [data-tour="teams-panel"]', all: true },
						interact: 'free' as const,
						msg: PMTUT_Msgs.breakdownSelect,
						prepare: ensureTeamsChartShown,
						advanceFromPrevious: {
							type: 'state' as const,
							inputs: (run: Tour.RunStores) => [run.squadServer],
							select: (s: any) => s.teamsPanel.groupFilter !== null,
							simulate: (ctx: Tour.SimulateCtx) => TeamsPanelPrt.Actions.setGroupFilter(panelStores(ctx.run), plan.group),
						},
					},
				]
			: []),
		...(groupStepsPossible && plan.unmatched
			? [
					{
						id: 'breakdown-unmatched',
						anchor: 'breakdown-unmatched',
						spotlight: 'teams-breakdown',
						msg: PMTUT_Msgs.breakdownUnmatched,
						prepare: ensureTeamsChartShown,
					},
				]
			: []),
		{ id: 'breakdown-history', anchor: { all: 'match-history' }, msg: PMTUT_Msgs.breakdownHistory },

		// searching, filtering and sorting
		{
			id: 'column-filter',
			anchor: 'players-col-squad',
			spotlight: 'teams-panel',
			interact: 'free',
			msg: { title: PMTUT_Msgs.columnFilter.title, body: () => PMTUT_Msgs.columnFilter.body(FILTER_SQUAD.name) },
			prepare: ensureTeamsShown,
		},
		{
			id: 'remove-filter',
			anchor: 'players-col-squad',
			spotlight: 'teams-panel',
			interact: 'free',
			msg: PMTUT_Msgs.removeFilter,
			prepare: ensureTeamsShown,
			advanceFromPrevious: {
				type: 'state',
				inputs: (run) => [run.squadServer],
				select: (s: any) => Object.values(s.teamsPanel.squadFilters).some((v) => v !== null),
				simulate: simFilterSquad,
			},
		},
		{
			id: 'search',
			anchor: 'teams-search',
			interact: 'free',
			msg: PMTUT_Msgs.search,
			prepare: ensureTeamsShown,
			advanceFromPrevious: { type: 'state', ...noColumnFilters, simulate: simClearFilters },
		},
		{
			id: 'squad-sorting',
			anchor: 'players-col-squad',
			spotlight: 'teams-tables',
			msg: PMTUT_Msgs.squadSorting,
			prepare: ensureTeamsShown,
		},
		{
			id: 'show-spoilers',
			anchor: 'teams-show-spoilers',
			interact: 'anchor-only',
			msg: PMTUT_Msgs.showSpoilers,
			prepare: ensureTeamsShown,
		},
		{
			id: 'score-sorting',
			anchor: 'players-stats-sort',
			spotlight: 'teams-tables',
			interact: 'free',
			msg: PMTUT_Msgs.scoreSorting,
			prepare: ensureTeamsShown,
			advanceFromPrevious: {
				type: 'state',
				inputs: (run) => [run.squadServer],
				select: TeamsPanelPrt.Sel.showSpoilers,
				simulate: (ctx) => TeamsPanelPrt.Actions.setShowSpoilers(panelStores(ctx.run), true),
			},
		},
		{ id: 'selecting', anchor: 'teams-tables', interact: 'free', msg: PMTUT_Msgs.selecting, prepare: ensureTeamsShown },
		{
			id: 'warn-selected',
			anchor: 'activity-warn',
			interact: 'free',
			msg: PMTUT_Msgs.Activity.warnSelected,
			advanceFromPrevious: {
				type: 'change',
				inputs: (run) => [run.squadServer],
				sample: SquadServerFrame.Sel.selectedPlayerCount,
				advanced: (from, to) => to > from,
				simulate: (ctx) => simSelect(ctx, [TARGETS.details]),
			},
		},
		{ id: 'reset-panel', anchor: 'teams-reset', interact: 'anchor-only', msg: PMTUT_Msgs.resetPanel, prepare: ensureTeamsShown },

		// the player details window
		{
			id: 'open-player-details',
			anchor: row(TARGETS.details),
			prepare: (run) => revealPlayer(run, TARGETS.details),
			interact: 'anchor-only',
			msg: { title: PMTUT_Msgs.PlayerDetails.open.title, body: () => PMTUT_Msgs.PlayerDetails.open.body(TARGETS.details) },
			advanceFromPrevious: { type: 'anchor', simulate: simResetPanel },
		},
		{
			id: 'player-details',
			anchor: 'player-details-window',
			msg: PMTUT_Msgs.PlayerDetails.window,
			premise: domPresent('player-details-window'),
			advanceFromPrevious: {
				type: 'state',
				...domPresent('player-details-window'),
				simulate: (ctx) => simOpenPlayerDetails(ctx, TARGETS.details),
			},
		},
		{
			id: 'player-details-ids',
			anchor: 'player-details-ids',
			spotlight: 'player-details-window',
			msg: PMTUT_Msgs.PlayerDetails.ids,
			premise: domPresent('player-details-window'),
		},
		{
			id: 'player-details-tags',
			anchor: 'player-details-tags',
			spotlight: 'player-details-window',
			msg: PMTUT_Msgs.PlayerDetails.tags,
			premise: domPresent('player-details-window'),
		},
		{
			id: 'player-details-activity',
			anchor: 'player-details-activity',
			spotlight: 'player-details-window',
			msg: PMTUT_Msgs.PlayerDetails.activity,
			premise: domPresent('player-details-window'),
		},

		// warning
		{
			id: 'warn-box',
			anchor: 'player-details-warn',
			spotlight: 'player-details-window',
			interact: 'free',
			msg: PMTUT_Msgs.Warn.box,
			premise: domPresent('player-details-window'),
		},
		{
			id: 'warn-options',
			anchor: 'warn-options',
			spotlight: 'player-details-warn',
			interact: 'free',
			msg: PMTUT_Msgs.Warn.options,
			premise: domPresent('player-details-window'),
		},
		...(warnPresets
			? [
					{
						id: 'warn-presets',
						anchor: 'warn-presets',
						spotlight: 'player-details-warn',
						interact: 'free' as const,
						msg: PMTUT_Msgs.Warn.presets,
						premise: domPresent('player-details-window'),
					},
				]
			: []),
		{
			id: 'warn-ingame',
			anchor: closeControl('player-details-window'),
			spotlight: 'player-details-window',
			interact: 'anchor-only',
			msg: withCommands(PMTUT_Msgs.Warn.ingame, WARN_COMMANDS),
			premise: domPresent('player-details-window'),
		},
		{
			id: 'warn-squad',
			anchor: squadHeader(TARGETS.squadWarn),
			prepare: (run) => revealSquadHeader(run, TARGETS.squadWarn),
			spotlight: 'teams-tables',
			interact: 'free',
			msg: {
				inputs: () => [SettingsClient.PublicSettingsStore],
				select: (settings: any) => ({
					title: tr.text(PMTUT_Msgs.Warn.squad.title()),
					body: Tour.richText(PMTUT_Msgs.Warn.squad.body(TARGETS.squadWarn, commandList(settings, SQUAD_COMMANDS))),
				}),
			},
			advanceFromPrevious: {
				type: 'state',
				...domPresent('player-details-window', false),
				simulate: () => closeWindows(WINDOW_ID.enum['player-details']),
			},
		},

		// acting on a player
		{
			id: 'actions-menu',
			anchor: row('Kestrel'),
			prepare: (run) => revealPlayer(run, 'Kestrel'),
			spotlight: 'teams-tables',
			interact: 'free',
			msg: PMTUT_Msgs.actionsMenu,
			checkpoint: CP_ROSTER,
		},
		{
			id: 'kick',
			anchor: row(TARGETS.kick),
			prepare: (run) => revealPlayer(run, TARGETS.kick),
			interact: 'free',
			msg: { title: PMTUT_Msgs.Kick.kick.title, body: () => PMTUT_Msgs.Kick.kick.body(TARGETS.kick) },
		},
		...inGame('kick-ingame', PMTUT_Msgs.Kick.ingame, KICK_COMMANDS, {
			advanceFromPrevious: { type: 'state', ...kicked, simulate: simKick },
		}),
		{
			id: 'timeout',
			anchor: row(TARGETS.timeout),
			prepare: (run) => revealPlayer(run, TARGETS.timeout),
			interact: 'free',
			msg: { title: PMTUT_Msgs.Timeouts.timeout.title, body: () => PMTUT_Msgs.Timeouts.timeout.body(TARGETS.timeout) },
			...(hasAnyCommand(KICK_COMMANDS) ? {} : { advanceFromPrevious: { type: 'state', ...kicked, simulate: simKick } }),
		},
		{
			id: 'timeouts-open',
			anchor: 'teams-timeouts',
			interact: 'anchor-only',
			msg: PMTUT_Msgs.Timeouts.openList,
			prepare: ensureTeamsShown,
			advanceFromPrevious: { type: 'state', ...timedOut, simulate: simTimeout },
		},
		{
			// on the rows rather than the window, which the card would otherwise cover, cancel buttons and all
			id: 'timeouts-list',
			anchor: { all: 'timeout-row' },
			interact: 'free',
			msg: PMTUT_Msgs.Timeouts.list,
			premise: domPresent('timeouts-window'),
			advanceFromPrevious: { type: 'state', ...domPresent('timeouts-window'), simulate: simOpenTimeouts },
		},
		{
			id: 'timeouts-ingame',
			anchor: closeControl('timeouts-window'),
			spotlight: 'timeouts-window',
			interact: 'anchor-only',
			msg: withCommands(PMTUT_Msgs.Timeouts.ingame, TIMEOUT_COMMANDS),
			premise: domPresent('timeouts-window'),
			advanceFromPrevious: { type: 'state', ...timeoutCancelled, simulate: simCancelTimeout },
		},

		// moving players between teams
		{
			id: 'swap-now',
			anchor: row(TARGETS.swapNow),
			prepare: (run) => revealPlayer(run, TARGETS.swapNow),
			interact: 'free',
			msg: { title: PMTUT_Msgs.SwapNow.swap.title, body: () => PMTUT_Msgs.SwapNow.swap.body(TARGETS.swapNow) },
			checkpoint: CP_ROSTER,
			advanceFromPrevious: {
				type: 'state',
				...domPresent('timeouts-window', false),
				simulate: () => closeWindows(WINDOW_ID.enum['timeouts']),
			},
		},
		...inGame('swap-now-ingame', PMTUT_Msgs.SwapNow.ingame, SWAP_NOW_COMMANDS, {
			advanceFromPrevious: { type: 'state', ...swappedNow, simulate: simSwapNow },
		}),
		{
			id: 'swap-next',
			anchor: row(TARGETS.swapNext),
			prepare: (run) => revealPlayer(run, TARGETS.swapNext),
			interact: 'free',
			msg: { title: PMTUT_Msgs.Teamswaps.swapNext.title, body: () => PMTUT_Msgs.Teamswaps.swapNext.body(TARGETS.swapNext) },
			...(hasAnyCommand(SWAP_NOW_COMMANDS) ? {} : { advanceFromPrevious: { type: 'state', ...swappedNow, simulate: simSwapNow } }),
		},
		{
			id: 'swaps-panel',
			anchor: 'swaps-panel',
			msg: PMTUT_Msgs.Teamswaps.panel,
			premise: domPresent('swaps-panel'),
			advanceFromPrevious: { type: 'state', ...swapNextQueued, simulate: simSwapNext },
		},
		{
			id: 'swaps-add-more',
			anchor: 'teams-tables',
			interact: 'free',
			msg: PMTUT_Msgs.Teamswaps.addMore,
			premise: domPresent('swaps-panel'),
		},
		{
			id: 'swaps-remove',
			anchor: { all: 'swap-badge' },
			spotlight: 'swaps-panel',
			interact: 'free',
			msg: PMTUT_Msgs.Teamswaps.remove,
			premise: domPresent('swaps-panel'),
		},
		{ id: 'swaps-save', anchor: 'swaps-save', spotlight: 'swaps-panel', interact: 'anchor-only', msg: PMTUT_Msgs.Teamswaps.save },
		{
			id: 'swaps-execute',
			anchor: 'swaps-execute',
			spotlight: 'swaps-panel',
			interact: 'free',
			msg: PMTUT_Msgs.Teamswaps.execute,
			advanceFromPrevious: { type: 'anchor', simulate: simSaveSwaps },
		},
		...inGame('teamswaps-ingame', PMTUT_Msgs.Teamswaps.ingame, TEAMSWAP_COMMANDS),
		{
			id: 'other-actions',
			msg: {
				inputs: () => [SettingsClient.PublicSettingsStore],
				select: (settings: any) => ({
					title: tr.text(PMTUT_Msgs.otherActions.title()),
					body: Tour.richText(PMTUT_Msgs.otherActions.body(commandList(settings, OTHER_COMMANDS))),
				}),
			},
		},

		// the switch queue, which players drive themselves
		...(switchEnabled
			? ([
					{
						id: 'switch-request',
						anchor: row(TARGETS.switchRequest),
						prepare: (run) => revealPlayer(run, TARGETS.switchRequest),
						spotlight: 'teams-tables',
						stage: 'switch-request',
						checkpoint: { stage: 'switch-request', ready: switchRequested },
						msg: {
							inputs: () => [SettingsClient.PublicSettingsStore],
							select: (settings: any) => ({
								title: tr.text(PMTUT_Msgs.SwitchQueue.request.title()),
								body: Tour.richText(
									PMTUT_Msgs.SwitchQueue.request.body(TARGETS.switchRequest, commandItem(settings, 'requestSwitch')),
								),
							}),
						},
					},
					{
						id: 'switch-open',
						anchor: 'teams-switch-requests',
						interact: 'anchor-only',
						msg: PMTUT_Msgs.SwitchQueue.openWindow,
						prepare: ensureTeamsShown,
					},
					{
						id: 'switch-window',
						anchor: 'switch-requests-window',
						msg: PMTUT_Msgs.SwitchQueue.window,
						premise: domPresent('switch-requests-window'),
						advanceFromPrevious: { type: 'state', ...domPresent('switch-requests-window'), simulate: simOpenSwitchRequests },
					},
					{
						id: 'switch-now',
						anchor: 'switch-now',
						interact: 'anchor-only',
						msg: PMTUT_Msgs.SwitchQueue.switchNow,
						premise: domPresent('switch-requests-window'),
					},
					{
						id: 'switch-ingame',
						anchor: closeControl('switch-requests-window'),
						spotlight: 'switch-requests-window',
						interact: 'anchor-only',
						msg: withCommands(PMTUT_Msgs.SwitchQueue.ingame, SWITCH_COMMANDS),
						premise: domPresent('switch-requests-window'),
						advanceFromPrevious: { type: 'state', ...switchQueueEmpty, simulate: simSwitchNow },
					},
				] satisfies Tour.Step[])
			: []),

		{
			id: 'finish',
			advanceFromPrevious: switchEnabled
				? {
						type: 'state',
						...domPresent('switch-requests-window', false),
						simulate: () => closeWindows(WINDOW_ID.enum['switch-requests']),
					}
				: undefined,
			msg: {
				inputs: () => [SettingsClient.PublicSettingsStore],
				select: (settings: any) => ({
					title: tr.text(PMTUT_Msgs.finish.title()),
					body: Tour.richText(PMTUT_Msgs.finish.body(commandItem(settings, 'help'))),
				}),
			},
		},
	])
}

// the plan is made once per run, before the first step, so resetClient and the steps agree on the grouping
let activePlan: GroupingPlan = { ids: [], groupingId: null, group: null, unmatched: false }

Tour.registerScenario('player-management', {
	steps: () => {
		activePlan = planGroupings()
		return buildSteps(activePlan)
	},
	resetClient: (run) => resetClient(run, activePlan),
})
