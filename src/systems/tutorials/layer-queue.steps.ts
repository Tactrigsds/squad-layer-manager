import * as Im from 'immer'
import React from 'react'
import { flushSync } from 'react-dom'

import { pairedScoreDimensions } from '@/components/layer-info-window.helpers'
import ShortLayerName from '@/components/short-layer-name'
import * as LayerFilterMenuPrt from '@/frame-partials/layer-filter-menu.partial'
import * as LayerQueuePrt from '@/frame-partials/layer-queue.partial'
import * as LayerTablePrt from '@/frame-partials/layer-table.partial'
import * as PoolCheckboxesPrt from '@/frame-partials/pool-checkboxes.partial'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import { setGlobalHandle } from '@/lib/use-state-with-global-handle'
import * as Zus from '@/lib/zustand'
import * as M from '@/messages/tutorials/layer-queue-tutorial.messages'
import * as CMD from '@/models/command.models'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as LL from '@/models/layer-list.models'
import * as LNote from '@/models/layer-notes.models'
import * as TUT from '@/models/tutorial.models'
import * as UP from '@/models/user-presence'
import * as ConfigClient from '@/systems/config.client'
import { DraggableWindowStore, openOrFocusWindow } from '@/systems/draggable-window.client'
import * as LayerQueriesClient from '@/systems/layer-queries.client'
import { tr } from '@/systems/messages.client'
import * as SettingsClient from '@/systems/settings.client'
import * as Tour from '@/systems/tour.client'
import * as UPClient from '@/systems/user-presence.client'

// The client half of the layer queue tutorial: the step list the tour walks against the live dashboard. The order
// is the curriculum -- read the queue, then edit it, then see what configures it -- and the copy is in
// @/messages/tutorials/layer-queue-tutorial.messages. Importing this file registers the scenario.
//
// Each step's advanceFromPrevious is the transition INTO it: what the user does on the previous step to arrive
// here, plus (as simulate) the programmatic equivalent a jump replays. Steps at server-state boundaries carry a
// checkpoint; jumping anywhere runs the nearest checkpoint at or before the target and replays the simulates in
// between. Steps whose subject can be dismissed -- an open dialog, an edit session, a draggable window -- carry
// the premise that keeps them honest, and the tour walks back when it is lost.

// The queue edits only make sense while the local client holds an editing session; if the user saves or exits, the
// tour regresses to the nearest step without this premise. Deliberately the OWN CLIENT's activity, not
// Sel.isEditing: that set is user-level across every server, so it also passes on a session another tab holds on
// another dashboard. The tour pauses whenever this route is left, so own-client editing is editing the run's server.
const editingQueue: Tour.StateSelector<boolean> = {
	inputs: () => [UPClient.Store],
	select: (upState) => {
		const clientId = ConfigClient.getConfig()?.wsClientId
		const activity = clientId ? upState.presence.get(clientId)?.activityState : null
		return !!activity?.child?.EDITING_QUEUE
	},
}

// the Add Layers pool dialog is open: an active `selectLayers` loader for the ADDING_ITEM activity
const isAddDialogEntry = (e: any) => e.name === 'selectLayers' && e.active && e.data?.activity?.id === 'ADDING_ITEM'
const addDialogOpen: Tour.StateSelector<boolean> = {
	inputs: () => [UPClient.Store],
	select: (upState) => UPClient.Sel.loadedActivities(upState).some(isAddDialogEntry),
}

// the select-layers frame behind the open dialog. Resolved when a gated step wires up, which is after the dialog
// has opened; the UPClient.Store fallback makes the selector read false rather than throw once it is gone.
function addDialogFrame(): Zus.AnyInput<any> {
	const entry = UPClient.Sel.loadedActivities(Zus.getState(UPClient.Store)).find(isAddDialogEntry) as any
	return entry?.data?.selectLayersFrame ?? UPClient.Store
}

// the dialog is open AND its frame has loaded, which is what a simulate that writes frame state has to wait for
const addDialogFrameReady: Tour.StateSelector<boolean> = {
	inputs: () => [UPClient.Store],
	select: (upState) => {
		const entry = UPClient.Sel.loadedActivities(upState).find(isAddDialogEntry) as any
		return entry?.data?.selectLayersFrame != null
	},
}

// presentational state the house does not push into a store: whether a window, dialog or menu carrying this
// data-tour id is currently laid out. The engine's DOM input is the same contract the e2e suite reads.
function domPresent(target: Tour.AnchorTarget, present = true): Tour.StateSelector<boolean> {
	return {
		inputs: () => [Tour.domInput(Tour.anchorSelector(target))],
		select: (els: Element[]) => els.some((el) => el.getClientRects().length > 0) === present,
	}
}

// the layer the add walkthrough asks for, and the map it then switches to. Both have to be in the sandbox pool.
const ADD_TARGET = { map: 'Chora', gamemode: 'TC', faction: 'CAF' }
// the gamemode and faction from ADD_TARGET are still set when this step runs, so the second map has to carry
// layers for them: AlBasrah has no TC layers at all, which left the step with an empty table
const ADD_SECOND = { map: 'Yehorivka' }
const LAYERS = TUT.LQ_TUTORIAL_LAYERS

// whether the filter menu comparison currently selects `value`, whichever comp shape the menu item holds
function compSelects(node: any, value: string): boolean {
	if (!node || node.neg) return false
	return (node.args ?? []).some(
		(a: any) => (a.type === 'value' && a.value === value) || (a.type === 'values' && (a.values ?? []).includes(value)),
	)
}

const queueLength = (s: any) => s.queue.layerList.length as number
const queueOrder = (s: any) => s.queue.layerList.map((it: any) => it.itemId).join(',') as string
const head = (s: any) => s.queue.layerList[0]
const headTagCount = (s: any) => (head(s)?.tags?.length ?? 0) as number
const headNoteCount = (s: any) => (head(s)?.notes?.length ?? 0) as number
const headIsGenerated = (s: any) => head(s)?.source?.type === 'generated'
// the head as a parsed layer, for the cards whose examples are read off it. A raw layer id has no configuration to
// take apart, so those cards render without their example rather than guessing one.
function headLayer(s: any): L.KnownLayer | null {
	const item = head(s)
	if (!item) return null
	const layer = L.toLayer(item.layerId)
	return L.isKnownLayer(layer) ? layer : null
}

const filterMenu = (s: any) => s?.filterMenu?.menuItems

// the layer details window, for selectors scoping a shared control to this one
const WINDOW = '[data-tour="layer-details-window"]'

// ============================== simulates ==============================
// The programmatic equivalents of the user actions transitions wait for: store and op writes, never DOM clicks.
// Sync unless a round trip is unavoidable; every one is safe to replay over state a checkpoint installed.

const queueStores = (run: Tour.RunStores) => ({ queue: run.squadServer })
const list = (run: Tour.RunStores) => Zus.getState(run.squadServer).queue.layerList as any[]

const TUTORIAL_TAG = 'Tutorial:tut001'

async function simStartEditing(ctx: Tour.SimulateCtx) {
	UPClient.Actions.ensureEditingQueue(ctx.run.serverId)
	await Tour.awaitSelector(ctx.run, editingQueue, ctx.signal, 3000)
}

async function simOpenAddDialog(ctx: Tour.SimulateCtx) {
	UPClient.Actions.updateActivity(
		UP.createEditingQueueVariant({
			_tag: 'leaf',
			id: 'ADDING_ITEM',
			opts: { cursor: { type: 'start' }, variant: 'toggle-position', action: 'add' },
		})(),
	)
	await Tour.awaitSelector(ctx.run, addDialogFrameReady, ctx.signal, 3000)
}

// select a value on a filter menu field the way the menu inputs do, preserving the comp's value/values shape
function selectFilterValue(field: string, value: string) {
	LayerFilterMenuPrt.Actions.setComparison({ filterMenu: addDialogFrame() } as any, field, (prev) =>
		Im.produce(prev, (draft) => {
			const valuesArg = draft.args.find((arg): arg is F.EditableValuesArg => arg?.type === 'values')
			if (valuesArg) valuesArg.values = [value]
			else F.setCompValue(draft, value)
		}),
	)
}

function simSetAddFilters() {
	selectFilterValue('Map', ADD_TARGET.map)
	selectFilterValue('Gamemode', ADD_TARGET.gamemode)
	selectFilterValue('Faction_1', ADD_TARGET.faction)
}

function simToggleHideRepeats() {
	PoolCheckboxesPrt.Actions.setCheckbox({ poolCheckboxes: addDialogFrame() } as any, 'dnr', 'regular')
}

function simSelect(layerId: string) {
	LayerTablePrt.Actions.setSelected({ layerTable: addDialogFrame() } as any, (prev) =>
		prev.includes(layerId as L.LayerId) ? prev : [...prev, layerId as L.LayerId],
	)
}

function simShowSelected() {
	LayerTablePrt.Actions.setShowSelectedLayers({ layerTable: addDialogFrame() } as any, true)
}

function simReorder(ctx: Tour.SimulateCtx) {
	const items = list(ctx.run)
	if (items.length < 2) return
	const last = items[items.length - 1]
	const prev = items[items.length - 2]
	LayerQueuePrt.Actions.dispatchItemOp(queueStores(ctx.run) as any, last.itemId, {
		op: 'move',
		cursor: { type: 'item-relative', itemId: prev.itemId, position: 'before' },
		newFirstItemId: LL.createItemId(),
	})
}

// the canonical removal is the last seed layer, so the CAF picks that trip the save warning stay in the draft
function simRemoveSeed(ctx: Tour.SimulateCtx) {
	const items = list(ctx.run)
	const target = items.find((it) => it.layerId === LAYERS.initial[2]) ?? items[items.length - 1]
	if (target) LayerQueuePrt.Actions.dispatchItemOp(queueStores(ctx.run) as any, target.itemId, { op: 'delete' })
}

function simSwapHead(ctx: Tour.SimulateCtx) {
	const target = head(Zus.getState(ctx.run.squadServer))
	if (target) LayerQueuePrt.Actions.dispatchItemOp(queueStores(ctx.run) as any, target.itemId, { op: 'swap-factions' })
}

function simRemoveHead(ctx: Tour.SimulateCtx) {
	const target = head(Zus.getState(ctx.run.squadServer))
	if (target) LayerQueuePrt.Actions.dispatchItemOp(queueStores(ctx.run) as any, target.itemId, { op: 'delete' })
}

async function simOpenEditLayer(ctx: Tour.SimulateCtx) {
	const target = head(Zus.getState(ctx.run.squadServer))
	if (!target) return
	UPClient.Actions.updateActivity(
		UP.createEditingQueueVariant({
			_tag: 'leaf',
			id: 'EDITING_ITEM',
			opts: { itemId: target.itemId, cursor: { type: 'item-relative', itemId: target.itemId, position: 'on' } },
		})(),
	)
	await Tour.awaitSelector(ctx.run, domPresent('edit-layer-dialog'), ctx.signal, 3000)
}

function simCloseQueueSubActivity() {
	UPClient.Actions.updateActivity(UP.toEditingQueueIdleOrNone())
}

function simAddTag(ctx: Tour.SimulateCtx) {
	const target = head(Zus.getState(ctx.run.squadServer))
	if (!target || target.tags?.includes(TUTORIAL_TAG)) return
	LayerQueuePrt.Actions.dispatchItemOp(queueStores(ctx.run) as any, target.itemId, { op: 'add-tag', tagId: TUTORIAL_TAG })
}

function simAddNote(ctx: Tour.SimulateCtx) {
	const target = head(Zus.getState(ctx.run.squadServer))
	if (!target || (target.notes?.length ?? 0) > 0) return
	LayerQueuePrt.Actions.dispatchItemOp(queueStores(ctx.run) as any, target.itemId, {
		op: 'add-note',
		noteId: LNote.createNoteId(),
		text: 'Tutorial note',
	})
}

// the first save press: surface the warnings the draft causes, without saving. The flag is component state behind
// a global handle; the warnings must have computed first or the panel's own effect clears it again.
async function simShowSaveWarnings(ctx: Tour.SimulateCtx) {
	await SquadServerFrame.awaitCurrentStatuses(ctx.run.squadServer)
	await SquadServerFrame.refreshSavedQueueWarnings(ctx.run.squadServer)
	if (ctx.signal.aborted) return
	setGlobalHandle(TUT.TOUR_HANDLES.queueSaveWarnings, true)
}

async function simOpenLayerDetails(ctx: Tour.SimulateCtx) {
	const target = head(Zus.getState(ctx.run.squadServer))
	if (!target) return
	// the window definition registers on module import; flushSync commits the mount so the tab handle below is
	// settable on the next line of a jump
	await import('@/components/layer-info')
	flushSync(() => openOrFocusWindow(WINDOW_ID.enum['layer-info'], { layerId: target.layerId }))
}

function simShowLayerScores() {
	setGlobalHandle(TUT.TOUR_HANDLES.layerInfoTab, 'scores')
}

function simCloseLayerDetails() {
	const store = DraggableWindowStore.getState()
	for (const w of store.windows.filter((w) => w.type === WINDOW_ID.enum['layer-info'])) store.closeWindow(w.id)
}

async function simOpenPoolConfig(ctx: Tour.SimulateCtx) {
	await import('@/components/pool-config-window')
	if (ctx.signal.aborted) return
	flushSync(() => openOrFocusWindow(WINDOW_ID.enum['pool-config'], { stores: { squadServer: ctx.run.squadServer } }))
}

function simShowRepeatRules() {
	setGlobalHandle(TUT.TOUR_HANDLES.poolConfigTab, 'repeatRules')
}

// Close every window a step may have opened and clear stale handle state. Presence-driven dialogs are deliberately
// NOT closed here: the checkpoint's end-all-editing clears the whole activity subtree server-side, and a client op
// would race it -- toEditingQueueIdleOrNone also ASSERTS an editing session, so losing that race leaves the reader
// spuriously editing after a jump into a non-editing region.
function resetClient(run: Tour.RunStores) {
	const store = DraggableWindowStore.getState()
	for (const w of [...store.windows]) store.closeWindow(w.id)
	setGlobalHandle(TUT.TOUR_HANDLES.queueSaveWarnings, false)
	void run
}

// ============================== what this install can teach ==============================

// Whether the tutorial's own head layer carries scores, and whether they are the ones SLM ships. An install can
// define its own scoring columns, or none at all, and the scores arc has to say something different in each case
// -- including nothing, since the Scores tab is disabled for a layer with no scores and the step asking the
// reader to open it could never be completed.
//
// Read off the seeded head layer rather than the queue, because the queue is not loaded yet when the run starts,
// and that layer is a constant of the scenario.
async function scoreSupport(): Promise<{ any: boolean; builtin: boolean; categories: boolean }> {
	try {
		const layer = await LayerQueriesClient.fetchLayerInfo(LAYERS.initial[0])
		const scores = LC.partitionScores(layer, LC.getEffectiveColumnConfig())
		return {
			any: Object.values(scores).some((group) => Object.values(group).some((score) => typeof score === 'number')),
			// the two the copy actually explains; a value can only be here if the column is defined
			builtin: typeof scores.diffs['Balance_Differential'] === 'number' && typeof scores.other['Asymmetry_Score'] === 'number',
			// the per-team chart under them, which is only drawn for dimensions score-ranges.json pairs
			categories: pairedScoreDimensions(scores).length > 0,
		}
	} catch (error) {
		// nothing provable about the scores is a reason to leave the arc out, not to narrate it and hope
		console.error("tour: could not read the tutorial layer's scores, leaving the scores steps out", error)
		return { any: false, builtin: false, categories: false }
	}
}

// ============================== checkpoints ==============================
// One per region of the tour whose server state differs; the stage ids are the scenario's cp-* stages. `ready`
// pins the state the client must observe before replaying simulates on top of it.

function cpReady(opts: { head: string; length: number; editing: boolean }): Tour.StateSelector<boolean> {
	return {
		inputs: (run) => [run.squadServer, UPClient.Store],
		select: (s: any, upState: any) => {
			const items = s.queue.layerList
			return items.length === opts.length && items[0]?.layerId === opts.head && editingQueue.select(upState) === opts.editing
		},
	}
}

const CP = {
	fresh: { stage: 'cp-fresh', ready: cpReady({ head: LAYERS.initial[0], length: 3, editing: false }) },
	edited: { stage: 'cp-edited', ready: cpReady({ head: LAYERS.picks.chora, length: 5, editing: true }) },
	saved: { stage: 'cp-saved', ready: cpReady({ head: LAYERS.picks.chora, length: 4, editing: false }) },
	postForce: { stage: 'cp-post-force', ready: cpReady({ head: LAYERS.picks.yehorivka, length: 3, editing: false }) },
	generated: {
		stage: 'cp-generated',
		ready: {
			inputs: (run) => [run.squadServer],
			select: (s: any) => queueLength(s) === 1 && headIsGenerated(s),
		} as Tour.StateSelector<boolean>,
	},
} satisfies Record<string, Tour.Checkpoint>

// ============================== steps ==============================

export async function buildSteps() {
	const scores = await scoreSupport()
	return Tour.defineSteps([
		{ id: 'welcome', msg: M.welcome, checkpoint: CP.fresh },
		{ id: 'sandbox', anchor: 'server-name', msg: M.sandbox },
		{ id: 'match-history', anchor: { all: 'match-history' }, msg: M.matchHistory },
		{ id: 'queue-panel', anchor: 'queue-panel', msg: M.queuePanel },

		// reading the queue, before any editing
		{ id: 'queue-items', anchor: 'queue-item', msg: M.queueItems },
		{
			id: 'next-badge',
			anchor: 'queue-next-badge',
			spotlight: 'queue-item',
			msg: {
				inputs: () => [SettingsClient.PublicSettingsStore],
				select: (settings: any) => {
					const cmd = settings?.commands?.showNext
					// already prefixed by the settings seed, so these are what a player types verbatim
					const triggers: string[] = cmd?.enabled === false ? [] : (cmd?.triggers ?? []).map(CMD.triggerString)
					return { title: tr.text(M.nextBadge.title()), body: Tour.richText(M.nextBadge.body(triggers)) }
				},
			},
		},
		{
			id: 'layer-anatomy',
			anchor: 'queue-layer-name',
			msg: {
				inputs: (run) => [run.squadServer],
				select: (s: any) => {
					const layer = headLayer(s)
					return {
						title: tr.text(M.layerAnatomy.title()),
						body: layer ? Tour.richText(M.layerAnatomy.body(layer)) : null,
					}
				},
			},
		},
		{
			// the whole run of tagged rows, so the alternating (1)/(2) marks down the queue are visible in one zone. The
			// card's example is the queue's own head layer rendered with normalization off, beside the normalized one.
			id: 'team-normalize',
			anchor: { all: 'queue-item' },
			msg: {
				inputs: (run) => [run.squadServer],
				select: (s: any) => ({
					title: tr.text(M.teamNormalize.title()),
					body: Tour.richText(
						M.teamNormalize.body(
							head(s) ? React.createElement(ShortLayerName, { layerId: head(s).layerId, teamParity: 0, normalized: false }) : null,
						),
					),
				}),
			},
		},
		// both cards tell the reader to hover the indicator, so the anchor has to stay reachable: the default
		// interact blocks the whole page, which leaves the instruction doing nothing
		{
			id: 'filter-indicators',
			anchor: 'layer-indicators',
			spotlight: 'queue-item',
			interact: 'anchor-only',
			msg: M.filterIndicators,
		},
		{
			id: 'repeat-indicators',
			anchor: 'layer-indicators',
			spotlight: 'queue-item',
			interact: 'anchor-only',
			msg: M.repeatIndicators,
		},

		// the layer details window
		{
			id: 'open-layer-details',
			anchor: 'queue-layer-name',
			interact: 'anchor-only',
			msg: M.LayerDetails.openLayerDetails,
		},
		{
			id: 'layer-details',
			anchor: 'layer-details-window',
			msg: M.LayerDetails.layerDetails,
			premise: domPresent('layer-details'),
			advanceFromPrevious: { type: 'state', ...domPresent('layer-details'), simulate: simOpenLayerDetails },
		},
		// The scores arc, or nothing. An install can ship SLM's scores, its own, or none; with none the Scores tab
		// is disabled and asking the reader to open it would strand them. Whichever card comes first here is
		// entered by opening the tab, so both carry that transition.
		...(scores.any
			? [
					{
						id: 'open-layer-scores',
						anchor: 'layer-info-tabs',
						interact: 'anchor-only' as const,
						msg: M.LayerDetails.openLayerScores,
					},
				]
			: []),
		...(scores.builtin
			? [
					{
						id: 'layer-scores',
						anchor: 'layer-details-window',
						msg: M.LayerDetails.layerScores,
						premise: domPresent('layer-scores'),
						advanceFromPrevious: { type: 'state' as const, ...domPresent('layer-scores'), simulate: simShowLayerScores },
					},
					{
						id: 'balance-score',
						anchor: 'layer-score-Balance_Differential',
						spotlight: 'layer-details-window',
						msg: M.LayerDetails.balanceScore,
						premise: domPresent('layer-scores'),
					},
					{
						id: 'asymmetry-score',
						anchor: 'layer-score-Asymmetry_Score',
						spotlight: 'layer-details-window',
						msg: M.LayerDetails.asymmetryScore,
						premise: domPresent('layer-scores'),
					},
					...(scores.categories
						? [
								{
									id: 'category-scores',
									anchor: 'layer-score-categories',
									spotlight: 'layer-details-window',
									msg: M.LayerDetails.categorySpecificScores,
									premise: domPresent('layer-scores'),
								},
							]
						: []),
				]
			: scores.any
				? [
						{
							id: 'layer-scores-nonstandard',
							anchor: 'layer-details-window',
							msg: M.LayerDetails.layerScoresNonstandard,
							premise: domPresent('layer-scores'),
							advanceFromPrevious: { type: 'state' as const, ...domPresent('layer-scores'), simulate: simShowLayerScores },
						},
					]
				: []),
		{
			// a draggable window outlives the step that opened it, and it sits over the queue the next steps narrate
			id: 'close-layer-details',
			anchor: { css: `${WINDOW} [data-window-control="close"]` },
			interact: 'anchor-only',
			msg: M.closeLayerDetails,
		},
		{
			id: 'layer-context-menu',
			anchor: 'queue-layer-name',
			interact: 'free',
			msg: M.layerContextMenu,
			advanceFromPrevious: { type: 'state', ...domPresent('layer-details-window', false), simulate: simCloseLayerDetails },
		},

		// editing
		{ id: 'start-editing', anchor: 'queue-edit', interact: 'anchor-only', msg: M.startEditing },
		{
			id: 'queue-editors',
			anchor: 'queue-editors',
			msg: M.queueUserPresence,
			premise: editingQueue,
			advanceFromPrevious: { type: 'anchor', simulate: simStartEditing },
		},

		// the layer selection dialog
		{
			id: 'add-layers-button',
			anchor: 'queue-add',
			interact: 'anchor-only',
			msg: M.AddLayersSequence.addLayersButton,
			premise: editingQueue,
		},
		{
			id: 'add-dialog-tour',
			anchor: 'add-dialog',
			msg: M.AddLayersSequence.addLayersDialogTour,
			premise: addDialogOpen,
			advanceFromPrevious: { type: 'state', ...addDialogOpen, simulate: simOpenAddDialog },
		},
		{
			id: 'layer-filter-menu',
			anchor: 'add-filters',
			interact: 'free',
			msg: {
				title: M.AddLayersSequence.layerFilterMenu.title,
				body: () => M.AddLayersSequence.layerFilterMenu.body(ADD_TARGET.map, ADD_TARGET.gamemode, ADD_TARGET.faction),
			},
			premise: addDialogOpen,
		},
		{
			id: 'results-table',
			anchor: 'add-pick',
			msg: M.AddLayersSequence.resultsTable,
			premise: addDialogOpen,
			advanceFromPrevious: {
				type: 'state',
				inputs: () => [addDialogFrame()],
				select: (s: any) => {
					const menu = filterMenu(s)
					if (!menu) return false
					return (
						compSelects(menu.Map, ADD_TARGET.map) &&
						compSelects(menu.Gamemode, ADD_TARGET.gamemode) &&
						(compSelects(menu.Faction_1, ADD_TARGET.faction) || compSelects(menu.Faction_2, ADD_TARGET.faction))
					)
				},
				simulate: simSetAddFilters,
			},
		},
		{
			id: 'results-pagination',
			anchor: 'table-pagination',
			spotlight: 'add-pick',
			msg: M.AddLayersSequence.pagination,
			premise: addDialogOpen,
		},
		{
			id: 'results-sorting',
			anchor: 'table-sort',
			spotlight: 'add-pick',
			interact: 'anchor-only',
			msg: M.AddLayersSequence.sorting,
			premise: addDialogOpen,
		},
		{
			// the dice and the toggle that reveals it, as one zone
			id: 'results-randomization',
			anchor: { all: 'table-randomize' },
			spotlight: 'add-pick',
			interact: 'anchor-only',
			msg: M.AddLayersSequence.randomization,
			premise: addDialogOpen,
		},
		{
			id: 'applied-filters',
			anchor: 'applied-filters',
			spotlight: 'add-dialog',
			interact: 'free',
			msg: M.AddLayersSequence.appliedFiltersToolbar,
			premise: addDialogOpen,
		},
		{ id: 'results-repeats', anchor: 'add-pick', msg: M.AddLayersSequence.repeats, premise: addDialogOpen },
		{
			id: 'hide-repeats',
			anchor: 'table-hide-repeats',
			spotlight: 'add-pick',
			interact: 'free',
			msg: M.AddLayersSequence.hideRepeats,
			premise: addDialogOpen,
		},
		{
			id: 'click-to-select',
			anchor: 'add-pick',
			interact: 'free',
			msg: M.AddLayersSequence.clickToSelect,
			premise: addDialogOpen,
			advanceFromPrevious: {
				type: 'change',
				inputs: () => [addDialogFrame()],
				sample: (s: any) => s?.poolCheckboxes?.checkboxesState?.dnr ?? null,
				advanced: (from, to) => from !== to,
				simulate: simToggleHideRepeats,
			},
		},
		{
			id: 'results-context-menu',
			anchor: 'add-pick',
			interact: 'free',
			msg: M.AddLayersSequence.rightClick,
			premise: addDialogOpen,
			advanceFromPrevious: {
				type: 'state',
				inputs: () => [addDialogFrame()],
				select: (s: any) => (s?.layerTable?.selected?.length ?? 0) > 0,
				simulate: () => simSelect(LAYERS.picks.chora),
			},
		},
		{
			// the reader edits the filters and picks from the results, so both regions are the subject
			id: 'add-another',
			anchor: { css: '[data-tour="add-filters"], [data-tour="add-pick"]', all: true },
			interact: 'free',
			msg: { title: M.AddLayersSequence.addAnother.title, body: () => M.AddLayersSequence.addAnother.body(ADD_SECOND.map) },
			premise: addDialogOpen,
		},
		{
			id: 'see-selection',
			anchor: 'table-show-selected',
			interact: 'free',
			msg: M.AddLayersSequence.seeSelection,
			premise: addDialogOpen,
			advanceFromPrevious: {
				type: 'state',
				inputs: () => [addDialogFrame()],
				// a count would also pass on the layer picked two steps ago, and this step is about seeing a selection
				// the filters have hidden, which only reads as that if the second pick really is from the second map
				select: (s: any) => ((s?.layerTable?.selected ?? []) as L.LayerId[]).some((id) => L.toLayer(id).Map === ADD_SECOND.map),
				simulate: () => simSelect(LAYERS.picks.yehorivka),
			},
		},
		{
			id: 'add-submit',
			anchor: 'add-submit',
			spotlight: 'add-dialog',
			interact: 'free',
			msg: M.AddLayersSequence.submit,
			premise: addDialogOpen,
			advanceFromPrevious: {
				type: 'state',
				inputs: () => [addDialogFrame()],
				select: (s: any) => s?.layerTable?.showSelectedLayers === true,
				simulate: simShowSelected,
			},
		},

		// what the edit looks like in the queue
		{
			// every row the reader just added, whichever positions they landed in: the union runs from the first to the
			// last. data-mutation is on the row already, and the queue-panel scope keeps other lists out of it.
			id: 'added-highlight',
			anchor: { css: '[data-tour="queue-panel"] li[data-mutation="added"]', all: true },
			msg: M.addedHighlight,
			premise: editingQueue,
			checkpoint: CP.edited,
			advanceFromPrevious: {
				type: 'change',
				inputs: (run) => [run.squadServer],
				sample: queueLength,
				advanced: (from, to) => to > from,
			},
		},
		{
			id: 'layer-attribution',
			anchor: 'queue-item-source',
			spotlight: 'queue-item',
			msg: M.layerAttribution,
			premise: editingQueue,
		},

		// the rest of the item actions
		{
			id: 'reorder',
			anchor: 'queue-reorder',
			spotlight: 'queue-panel',
			interact: 'free',
			msg: M.reorderLayer,
			premise: editingQueue,
		},
		{
			id: 'remove-layer',
			anchor: 'queue-delete',
			spotlight: 'queue-item',
			interact: 'anchor-only',
			msg: M.removeLayer,
			premise: editingQueue,
			advanceFromPrevious: {
				type: 'change',
				inputs: (run) => [run.squadServer],
				sample: queueOrder,
				advanced: (from, to) => from !== to,
				simulate: simReorder,
			},
		},
		{
			id: 'swap-teams',
			anchor: 'queue-swap',
			spotlight: 'queue-item',
			interact: 'anchor-only',
			msg: M.swapTeams,
			premise: editingQueue,
			advanceFromPrevious: { type: 'anchor', simulate: simRemoveSeed },
		},
		{
			id: 'edit-layer',
			anchor: 'queue-item-edit',
			spotlight: 'queue-item',
			interact: 'anchor-only',
			msg: M.editLayer,
			premise: editingQueue,
			advanceFromPrevious: { type: 'anchor', simulate: simSwapHead },
		},
		{
			id: 'edit-layer-dialog',
			anchor: 'edit-layer-dialog',
			interact: 'free',
			msg: M.editLayerSelection,
			advanceFromPrevious: { type: 'state', ...domPresent('edit-layer-dialog'), simulate: simOpenEditLayer },
		},
		{
			id: 'item-menu',
			anchor: 'queue-item-menu',
			spotlight: 'queue-item',
			interact: 'free',
			msg: M.layerItemEllipsis,
			premise: editingQueue,
			advanceFromPrevious: { type: 'state', ...domPresent('edit-layer-dialog', false), simulate: simCloseQueueSubActivity },
		},
		{
			// The ring is on the history, which is where the drag starts, but the queue is where it has to land: leaving
			// it dimmed and behind a blocker makes the instruction impossible to follow. A fresh sandbox holds only the
			// in-progress match, so the anchor is the whole history rather than a finished row.
			id: 'replay-layer',
			anchor: { all: 'match-history' },
			spotlight: { css: '[data-tour="match-history"], [data-tour="queue-panel"]', all: true },
			interact: 'free',
			msg: M.replayLayer,
			premise: editingQueue,
		},
		{
			id: 'add-tag',
			anchor: 'queue-item-display',
			spotlight: 'queue-item',
			interact: 'free',
			msg: M.addTag,
			premise: editingQueue,
		},
		{
			id: 'add-note',
			anchor: 'queue-item-display',
			spotlight: 'queue-item',
			interact: 'free',
			msg: M.notes,
			premise: editingQueue,
			advanceFromPrevious: {
				type: 'change',
				inputs: (run) => [run.squadServer],
				sample: headTagCount,
				advanced: (from, to) => to > from,
				simulate: simAddTag,
			},
		},

		// saving, and what saving depends on
		// Warnings first, and alone: arming force save skips the warning prompt entirely (see setEditing in
		// layer-queue-panel), so the two cannot be shown in the same pass. This pass saves the queue for real.
		//
		// Saving comes before the warnings card rather than after it, because the first press does not save -- it
		// surfaces the warnings the reader's own additions caused, and the card then has something to point at.
		{
			id: 'save',
			anchor: 'queue-save',
			interact: 'anchor-only',
			msg: M.save,
			premise: editingQueue,
			advanceFromPrevious: {
				type: 'change',
				inputs: (run) => [run.squadServer],
				sample: headNoteCount,
				advanced: (from, to) => to > from,
				simulate: simAddNote,
			},
		},
		{
			id: 'warnings-on-save',
			anchor: 'save-warnings',
			spotlight: { css: '[data-tour="save-warnings"], [data-tour="queue-save"]', all: true },
			interact: 'free',
			msg: M.warningsOnSave,
			// no editing premise here: the point of the step is the edit session ending on the second press
			advanceFromPrevious: { type: 'anchor', simulate: simShowSaveWarnings },
		},

		// The force-save arc needs an editing session of its own with a second editor in it, since force save only
		// overrides something while somebody else holds the queue.
		{
			id: 'force-save-editing',
			anchor: 'queue-edit',
			interact: 'anchor-only',
			msg: M.startEditingAgain,
			checkpoint: CP.saved,
			// arrives when the second save press goes through and ends the reader's session
			advanceFromPrevious: { type: 'state', inputs: () => [UPClient.Store], select: (upState: any) => !editingQueue.select(upState) },
		},
		{
			id: 'collaborative-editing',
			stage: 'second-editor',
			anchor: 'queue-editors',
			spotlight: { css: '[data-tour="queue-editors"], [data-tour="queue-save"]', all: true },
			msg: M.collaborativeEditing,
			premise: editingQueue,
			advanceFromPrevious: { type: 'anchor', simulate: simStartEditing },
		},
		{
			// with nothing to save, force save ends the reader's own session and kicks nobody: the copy promises more
			// than that, so the arc gives it something to override
			id: 'force-save-edit',
			anchor: 'queue-delete',
			spotlight: 'queue-item',
			interact: 'anchor-only',
			msg: M.forceSaveEdit,
			premise: editingQueue,
		},
		{
			id: 'force-save',
			anchor: 'queue-force-save',
			spotlight: { css: '[data-tour="queue-force-save"], [data-tour="queue-save"]', all: true },
			interact: 'free',
			msg: M.forceSave,
			premise: editingQueue,
			advanceFromPrevious: { type: 'anchor', simulate: simRemoveHead },
		},

		// generation, which needs an empty saved queue
		{
			id: 'autogen-intro',
			anchor: 'queue-panel',
			msg: M.Autogen.intro,
			checkpoint: CP.postForce,
			// armed and pressed: done once the queue is no longer the reader's to edit
			advanceFromPrevious: { type: 'state', inputs: () => [UPClient.Store], select: (upState: any) => !editingQueue.select(upState) },
		},
		{ id: 'autogen-editing', anchor: 'queue-edit', interact: 'anchor-only', msg: M.startEditingToClear },
		{
			// one step for both halves of the instruction: empty the queue, then save. Done is a generated head.
			id: 'autogen-try',
			anchor: 'queue-clear',
			spotlight: 'queue-panel',
			interact: 'free',
			msg: M.Autogen.tryItOut,
			advanceFromPrevious: { type: 'anchor', simulate: simStartEditing },
		},
		{
			id: 'autogen-item',
			anchor: 'queue-item-source',
			spotlight: 'queue-item',
			msg: M.Autogen.generatedItem,
			checkpoint: CP.generated,
			advanceFromPrevious: { type: 'state', inputs: (run) => [run.squadServer], select: headIsGenerated },
		},

		// what configures all of it
		{
			id: 'open-pool-settings',
			anchor: 'pool-settings',
			interact: 'anchor-only',
			msg: M.PoolSettings.showPoolSettings,
		},
		{
			id: 'pool-settings',
			anchor: 'pool-config-body',
			msg: M.PoolSettings.poolSettings,
			premise: domPresent('pool-config-body'),
			advanceFromPrevious: { type: 'state', ...domPresent('pool-config-body'), simulate: simOpenPoolConfig },
		},
		{
			id: 'pool-filter',
			anchor: 'pool-filter',
			msg: M.PoolSettings.poolFilter,
			premise: domPresent('pool-config-body'),
		},
		{
			id: 'indicate-matches',
			anchor: 'pool-list-indicateMatches',
			msg: M.PoolSettings.indicateMatchesAndMisses,
			premise: domPresent('pool-config-body'),
		},
		{
			id: 'default-select',
			anchor: 'pool-list-defaultSelectable',
			msg: M.PoolSettings.defaultSelect,
			premise: domPresent('pool-config-body'),
		},
		{
			id: 'view-repeat-rules',
			anchor: 'pool-config-tabs',
			interact: 'anchor-only',
			msg: M.PoolSettings.viewRepeatRules,
			premise: domPresent('pool-config-body'),
		},
		{
			id: 'repeat-rules',
			anchor: 'pool-repeat-rules',
			msg: M.PoolSettings.repeatRulesOverview,
			premise: domPresent('pool-repeat-rules'),
			advanceFromPrevious: { type: 'state', ...domPresent('pool-repeat-rules'), simulate: simShowRepeatRules },
		},
		{
			id: 'repeat-rule',
			anchor: 'pool-repeat-rules',
			msg: M.PoolSettings.repeatRule,
			premise: domPresent('pool-repeat-rules'),
		},
		{
			id: 'target-values',
			anchor: 'repeat-rule-targets',
			spotlight: 'pool-repeat-rules',
			msg: M.PoolSettings.targetValues,
			premise: domPresent('pool-repeat-rules'),
		},
		{
			id: 'rule-options',
			anchor: 'repeat-rule-options',
			spotlight: 'pool-repeat-rules',
			msg: M.PoolSettings.ruleOptions,
			premise: domPresent('pool-repeat-rules'),
		},
	])
}

Tour.registerScenario('layer-queue', { steps: buildSteps, resetClient })
