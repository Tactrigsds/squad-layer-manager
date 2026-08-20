import React from 'react'

import ShortLayerName from '@/components/short-layer-name'
import * as Zus from '@/lib/zustand'
import * as M from '@/messages/tutorials/layer-queue-tutorial.messages'
import * as L from '@/models/layer'
import { tr } from '@/systems/messages.client'
import * as Tour from '@/systems/tour.client'
import * as UPClient from '@/systems/user-presence.client'
import * as UsersClient from '@/systems/users.client'

// The client half of the layer queue tutorial: the step list the tour walks against the live dashboard. The order
// is the curriculum -- read the queue, then edit it, then see what configures it -- and the copy is in
// @/messages/tutorials/layer-queue-tutorial.messages. Importing this file registers the scenario.
//
// A step advances on whatever "done" means for it: a click on its own anchor (interact:'anchor-only'), a piece of
// state turning true, or a sampled value changing. Steps whose subject can be dismissed -- an open dialog, an edit
// session, a draggable window -- carry the premise that keeps them honest, and the tour walks back when it is lost.

// the queue edits only make sense while the local client holds an editing session; if the user saves or exits, the
// tour regresses to the nearest step without this premise
const editingQueue: Tour.StateSelector<boolean> = {
	inputs: () => [UPClient.Store],
	select: (upState) => !!UsersClient.loggedInUserId && !!UPClient.Sel.isEditing(UsersClient.loggedInUserId)(upState),
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

export const steps = Tour.defineSteps([
	{ id: 'welcome', msg: M.welcome, advance: { type: 'next' } },
	{ id: 'sandbox', anchor: 'server-name', msg: M.sandbox, advance: { type: 'next' } },
	{ id: 'match-history', anchor: { all: 'match-history' }, msg: M.matchHistory, advance: { type: 'next' } },
	{ id: 'queue-panel', anchor: 'queue-panel', msg: M.queuePanel, advance: { type: 'next' } },

	// reading the queue, before any editing
	{ id: 'queue-items', anchor: 'queue-item', msg: M.queueItems, advance: { type: 'next' } },
	{ id: 'next-badge', anchor: 'queue-next-badge', spotlight: 'queue-item', msg: M.nextBadge, advance: { type: 'next' } },
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
		advance: { type: 'next' },
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
		advance: { type: 'next' },
	},
	// both cards tell the reader to hover the indicator, so the anchor has to stay reachable: the default
	// interact blocks the whole page, which leaves the instruction doing nothing
	{
		id: 'filter-indicators',
		anchor: 'layer-indicators',
		spotlight: 'queue-item',
		interact: 'anchor-only',
		msg: M.filterIndicators,
		advance: { type: 'next' },
	},
	{
		id: 'repeat-indicators',
		anchor: 'layer-indicators',
		spotlight: 'queue-item',
		interact: 'anchor-only',
		msg: M.repeatIndicators,
		advance: { type: 'next' },
	},

	// the layer details window
	{
		id: 'open-layer-details',
		anchor: 'queue-layer-name',
		interact: 'anchor-only',
		msg: M.LayerDetails.openLayerDetails,
		advance: { type: 'state', ...domPresent('layer-details') },
	},
	{
		id: 'layer-details',
		anchor: 'layer-details-window',
		msg: M.LayerDetails.layerDetails,
		premise: domPresent('layer-details'),
		advance: { type: 'next' },
	},
	{
		id: 'open-layer-scores',
		anchor: 'layer-info-tabs',
		interact: 'anchor-only',
		msg: M.LayerDetails.openLayerScores,
		advance: { type: 'state', ...domPresent('layer-scores') },
	},
	{
		id: 'layer-scores',
		anchor: 'layer-details-window',
		msg: M.LayerDetails.layerScores,
		premise: domPresent('layer-scores'),
		advance: { type: 'next' },
	},
	{
		// a draggable window outlives the step that opened it, and it sits over the queue the next steps narrate
		id: 'close-layer-details',
		anchor: { css: `${WINDOW} [data-window-control="close"]` },
		interact: 'anchor-only',
		msg: M.closeLayerDetails,
		advance: { type: 'state', ...domPresent('layer-details-window', false) },
	},
	{ id: 'layer-context-menu', anchor: 'queue-layer-name', interact: 'free', msg: M.layerContextMenu, advance: { type: 'next' } },

	// editing
	{ id: 'start-editing', anchor: 'queue-edit', interact: 'anchor-only', msg: M.startEditing, advance: { type: 'anchor' } },
	{ id: 'queue-editors', anchor: 'queue-editors', msg: M.queueUserPresence, premise: editingQueue, advance: { type: 'next' } },

	// the layer selection dialog
	{
		id: 'add-layers-button',
		anchor: 'queue-add',
		interact: 'anchor-only',
		msg: M.AddLayersSequence.addLayersButton,
		premise: editingQueue,
		advance: { type: 'state', ...addDialogOpen },
	},
	{
		id: 'add-dialog-tour',
		anchor: 'add-dialog',
		msg: M.AddLayersSequence.addLayersDialogTour,
		premise: addDialogOpen,
		advance: { type: 'next' },
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
		advance: {
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
		},
	},
	{
		id: 'results-table',
		anchor: 'add-pick',
		msg: M.AddLayersSequence.resultsTable,
		premise: addDialogOpen,
		advance: { type: 'next' },
	},
	{
		id: 'results-pagination',
		anchor: 'table-pagination',
		spotlight: 'add-pick',
		msg: M.AddLayersSequence.pagination,
		premise: addDialogOpen,
		advance: { type: 'next' },
	},
	{
		id: 'results-sorting',
		anchor: 'table-sort',
		spotlight: 'add-pick',
		interact: 'anchor-only',
		msg: M.AddLayersSequence.sorting,
		premise: addDialogOpen,
		advance: { type: 'next' },
	},
	{
		// the dice and the toggle that reveals it, as one zone
		id: 'results-randomization',
		anchor: { all: 'table-randomize' },
		spotlight: 'add-pick',
		interact: 'anchor-only',
		msg: M.AddLayersSequence.randomization,
		premise: addDialogOpen,
		advance: { type: 'next' },
	},
	{
		id: 'applied-filters',
		anchor: 'applied-filters',
		spotlight: 'add-dialog',
		interact: 'free',
		msg: M.AddLayersSequence.appliedFiltersToolbar,
		premise: addDialogOpen,
		advance: { type: 'next' },
	},
	{ id: 'results-repeats', anchor: 'add-pick', msg: M.AddLayersSequence.repeats, premise: addDialogOpen, advance: { type: 'next' } },
	{
		id: 'hide-repeats',
		anchor: 'table-hide-repeats',
		spotlight: 'add-pick',
		interact: 'free',
		msg: M.AddLayersSequence.hideRepeats,
		premise: addDialogOpen,
		advance: {
			type: 'change',
			inputs: () => [addDialogFrame()],
			sample: (s: any) => s?.poolCheckboxes?.checkboxesState?.dnr ?? null,
			advanced: (from, to) => from !== to,
		},
	},
	{
		id: 'click-to-select',
		anchor: 'add-pick',
		interact: 'free',
		msg: M.AddLayersSequence.clickToSelect,
		premise: addDialogOpen,
		advance: {
			type: 'state',
			inputs: () => [addDialogFrame()],
			select: (s: any) => (s?.layerTable?.selected?.length ?? 0) > 0,
		},
	},
	{
		id: 'results-context-menu',
		anchor: 'add-pick',
		interact: 'free',
		msg: M.AddLayersSequence.rightClick,
		premise: addDialogOpen,
		advance: { type: 'next' },
	},
	{
		// the reader edits the filters and picks from the results, so both regions are the subject
		id: 'add-another',
		anchor: { css: '[data-tour="add-filters"], [data-tour="add-pick"]', all: true },
		interact: 'free',
		msg: { title: M.AddLayersSequence.addAnother.title, body: () => M.AddLayersSequence.addAnother.body(ADD_SECOND.map) },
		premise: addDialogOpen,
		advance: {
			type: 'state',
			inputs: () => [addDialogFrame()],
			// a count would also pass on the layer picked two steps ago, and the next step is about seeing a selection
			// the filters have hidden, which only reads as that if the second pick really is from the second map
			select: (s: any) => ((s?.layerTable?.selected ?? []) as L.LayerId[]).some((id) => L.toLayer(id).Map === ADD_SECOND.map),
		},
	},
	{
		id: 'see-selection',
		anchor: 'table-show-selected',
		interact: 'free',
		msg: M.AddLayersSequence.seeSelection,
		premise: addDialogOpen,
		advance: {
			type: 'state',
			inputs: () => [addDialogFrame()],
			select: (s: any) => s?.layerTable?.showSelectedLayers === true,
		},
	},
	{
		id: 'add-submit',
		anchor: 'add-submit',
		spotlight: 'add-dialog',
		interact: 'free',
		msg: M.AddLayersSequence.submit,
		premise: addDialogOpen,
		advance: { type: 'change', inputs: (run) => [run.squadServer], sample: queueLength, advanced: (from, to) => to > from },
	},

	// what the edit looks like in the queue
	{
		// every row the reader just added, whichever positions they landed in: the union runs from the first to the
		// last. data-mutation is on the row already, and the queue-panel scope keeps other lists out of it.
		id: 'added-highlight',
		anchor: { css: '[data-tour="queue-panel"] li[data-mutation="added"]', all: true },
		msg: M.addedHighlight,
		premise: editingQueue,
		advance: { type: 'next' },
	},
	{
		id: 'layer-attribution',
		anchor: 'queue-item-source',
		spotlight: 'queue-item',
		msg: M.layerAttribution,
		premise: editingQueue,
		advance: { type: 'next' },
	},

	// the rest of the item actions
	{
		id: 'reorder',
		anchor: 'queue-reorder',
		spotlight: 'queue-panel',
		interact: 'free',
		msg: M.reorderLayer,
		premise: editingQueue,
		advance: { type: 'change', inputs: (run) => [run.squadServer], sample: queueOrder, advanced: (from, to) => from !== to },
	},
	{
		id: 'remove-layer',
		anchor: 'queue-delete',
		spotlight: 'queue-item',
		interact: 'anchor-only',
		msg: M.removeLayer,
		premise: editingQueue,
		advance: { type: 'anchor' },
	},
	{
		id: 'swap-teams',
		anchor: 'queue-swap',
		spotlight: 'queue-item',
		interact: 'anchor-only',
		msg: M.swapTeams,
		premise: editingQueue,
		advance: { type: 'anchor' },
	},
	{
		id: 'edit-layer',
		anchor: 'queue-item-edit',
		spotlight: 'queue-item',
		interact: 'anchor-only',
		msg: M.editLayer,
		premise: editingQueue,
		advance: { type: 'state', ...domPresent('edit-layer-dialog') },
	},
	{
		id: 'edit-layer-dialog',
		anchor: 'edit-layer-dialog',
		interact: 'free',
		msg: M.editLayerSelection,
		advance: { type: 'state', ...domPresent('edit-layer-dialog', false) },
	},
	{
		id: 'item-menu',
		anchor: 'queue-item-menu',
		spotlight: 'queue-item',
		interact: 'free',
		msg: M.layerItemEllipsis,
		premise: editingQueue,
		advance: { type: 'next' },
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
		advance: { type: 'next' },
	},
	{
		id: 'add-tag',
		anchor: 'queue-item-display',
		spotlight: 'queue-item',
		interact: 'free',
		msg: M.addTag,
		premise: editingQueue,
		advance: { type: 'change', inputs: (run) => [run.squadServer], sample: headTagCount, advanced: (from, to) => to > from },
	},
	{
		id: 'add-note',
		anchor: 'queue-item-display',
		spotlight: 'queue-item',
		interact: 'free',
		msg: M.notes,
		premise: editingQueue,
		advance: { type: 'change', inputs: (run) => [run.squadServer], sample: headNoteCount, advanced: (from, to) => to > from },
	},

	// saving, and what saving depends on
	// Warnings first, and alone: arming force save skips the warning prompt entirely (see setEditing in
	// layer-queue-panel), so the two cannot be shown in the same pass. This pass saves the queue for real.
	//
	// Saving comes before the warnings card rather than after it, because the first press does not save -- it
	// surfaces the warnings the reader's own additions caused, and the card then has something to point at.
	{ id: 'save', anchor: 'queue-save', interact: 'anchor-only', msg: M.save, premise: editingQueue, advance: { type: 'anchor' } },
	{
		id: 'warnings-on-save',
		anchor: 'save-warnings',
		spotlight: { css: '[data-tour="save-warnings"], [data-tour="queue-save"]', all: true },
		interact: 'free',
		msg: M.warningsOnSave,
		// the alert clears when the save goes through, which is the reader pressing the button a second time. No
		// editing premise here: the point of the step is the edit session ending.
		advance: { type: 'state', ...domPresent('save-warnings', false) },
	},

	// The force-save arc needs an editing session of its own with a second editor in it, since force save only
	// overrides something while somebody else holds the queue.
	{ id: 'force-save-editing', anchor: 'queue-edit', interact: 'anchor-only', msg: M.startEditing, advance: { type: 'anchor' } },
	{
		id: 'collaborative-editing',
		stage: 'second-editor',
		anchor: 'queue-editors',
		spotlight: { css: '[data-tour="queue-editors"], [data-tour="queue-save"]', all: true },
		msg: M.collaborativeEditing,
		premise: editingQueue,
		advance: { type: 'next' },
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
		advance: { type: 'anchor' },
	},
	{
		id: 'force-save',
		anchor: 'queue-force-save',
		spotlight: { css: '[data-tour="queue-force-save"], [data-tour="queue-save"]', all: true },
		interact: 'free',
		msg: M.forceSave,
		premise: editingQueue,
		// armed and pressed: done once the queue is no longer the reader's to edit
		advance: { type: 'state', inputs: () => [UPClient.Store], select: (upState: any) => !editingQueue.select(upState) },
	},

	// generation, which needs an empty saved queue
	{ id: 'autogen-intro', anchor: 'queue-panel', msg: M.Autogen.intro, advance: { type: 'next' } },
	{ id: 'autogen-editing', anchor: 'queue-edit', interact: 'anchor-only', msg: M.startEditing, advance: { type: 'anchor' } },
	{
		// one step for both halves of the instruction: empty the queue, then save. Done is a generated head.
		id: 'autogen-try',
		anchor: 'queue-clear',
		spotlight: 'queue-panel',
		interact: 'free',
		msg: M.Autogen.tryItOut,
		advance: { type: 'state', inputs: (run) => [run.squadServer], select: headIsGenerated },
	},
	{ id: 'autogen-item', anchor: 'queue-item-source', spotlight: 'queue-item', msg: M.Autogen.generatedItem, advance: { type: 'next' } },

	// what configures all of it
	{
		id: 'open-pool-settings',
		anchor: 'pool-settings',
		interact: 'anchor-only',
		msg: M.PoolSettings.showPoolSettings,
		advance: { type: 'state', ...domPresent('pool-config-body') },
	},
	{
		id: 'pool-settings',
		anchor: 'pool-config-body',
		msg: M.PoolSettings.poolSettings,
		premise: domPresent('pool-config-body'),
		advance: { type: 'next' },
	},
	{
		id: 'pool-filter',
		anchor: 'pool-filter',
		msg: M.PoolSettings.poolFilter,
		premise: domPresent('pool-config-body'),
		advance: { type: 'next' },
	},
	{
		id: 'indicate-matches',
		anchor: 'pool-list-indicateMatches',
		msg: M.PoolSettings.indicateMatchesAndMisses,
		premise: domPresent('pool-config-body'),
		advance: { type: 'next' },
	},
	{
		id: 'default-select',
		anchor: 'pool-list-defaultSelectable',
		msg: M.PoolSettings.defaultSelect,
		premise: domPresent('pool-config-body'),
		advance: { type: 'next' },
	},
	{
		id: 'view-repeat-rules',
		anchor: 'pool-config-tabs',
		interact: 'anchor-only',
		msg: M.PoolSettings.viewRepeatRules,
		premise: domPresent('pool-config-body'),
		advance: { type: 'state', ...domPresent('pool-repeat-rules') },
	},
	{
		id: 'repeat-rules',
		anchor: 'pool-repeat-rules',
		msg: M.PoolSettings.repeatRulesOverview,
		premise: domPresent('pool-repeat-rules'),
		advance: { type: 'next' },
	},
	{
		id: 'repeat-rule',
		anchor: 'pool-repeat-rules',
		msg: M.PoolSettings.repeatRule,
		premise: domPresent('pool-repeat-rules'),
		advance: { type: 'next' },
	},
	{
		id: 'target-values',
		anchor: 'repeat-rule-targets',
		spotlight: 'pool-repeat-rules',
		msg: M.PoolSettings.targetValues,
		premise: domPresent('pool-repeat-rules'),
		advance: { type: 'next' },
	},
	{
		id: 'warns-and-autogen',
		anchor: { all: 'repeat-rule-flags' },
		spotlight: 'pool-repeat-rules',
		msg: M.PoolSettings.warnsAndAutogen,
		premise: domPresent('pool-repeat-rules'),
		advance: { type: 'next' },
	},
])

Tour.registerScenario('layer-queue', steps)
