import * as Zus from '@/lib/zustand'
import * as TUT_Msgs from '@/messages/tutorials.messages'
import * as L from '@/models/layer'
import { tr } from '@/systems/messages.client'
import * as Tour from '@/systems/tour.client'
import * as UPClient from '@/systems/user-presence.client'
import * as UsersClient from '@/systems/users.client'

// The client half of the layer-queue-basics tutorial: the step list the tour walks. It teaches the four queue edits
// -- add, remove, swap factions, reorder -- against the live dashboard. Adding is the most involved, so it walks the
// Add Layers pool dialog in its own right: open it, filter, pick, submit. Importing this file registers the scenario.
//
// Interactive steps spotlight one control. remove and swap use interact:'anchor-only' with advance:'anchor': a
// single click does the edit and moves the tour on. The steps that need the rest of the page (the pool dialog, the
// drop targets) run interact:'free' and advance on the resulting change to the queue or on Next.

// the queue edits only make sense while the local client holds an editing session; if the user saves or exits, the
// tour regresses to start-editing (its anchor, Start Editing, is the nearest step without this premise)
const editingQueue: Tour.StateSelector<boolean> = {
	inputs: () => [UPClient.Store],
	select: (upState) => !!UsersClient.loggedInUserId && !!UPClient.Sel.isEditing(UsersClient.loggedInUserId)(upState),
}

// the Add Layers pool dialog is open: an active `selectLayers` loader for the ADDING_ITEM activity. The in-dialog
// steps depend on it, so closing the dialog regresses the tour to the step that opens it.
const isAddDialogEntry = (e: any) => e.name === 'selectLayers' && e.active && e.data?.activity?.id === 'ADDING_ITEM'
const addDialogOpen: Tour.StateSelector<boolean> = {
	inputs: () => [UPClient.Store],
	select: (upState) => UPClient.Sel.loadedActivities(upState).some(isAddDialogEntry),
}

// the select-layers frame behind the open dialog. Resolved when a gated step wires up, which is after open-add has
// advanced on the dialog opening; the UPClient.Store fallback makes the selector read false rather than throw if
// the dialog is gone (the addDialogOpen premise then regresses the step anyway).
function addDialogFrame(): Zus.AnyInput<any> {
	const entry = UPClient.Sel.loadedActivities(Zus.getState(UPClient.Store)).find(isAddDialogEntry) as any
	return entry?.data?.selectLayersFrame ?? UPClient.Store
}

// the layer the add walkthrough asks for. Must be in the seeded sandbox pool; the scenario's own queue head is a
// Gorodok USA layer, so this pair is.
const ADD_TARGET = { map: 'Gorodok', faction: 'USA' }

// whether the filter menu comparison currently selects `value`, whichever comp shape the menu item holds
function compSelects(node: any, value: string): boolean {
	if (!node || node.neg) return false
	return (node.args ?? []).some(
		(a: any) => (a.type === 'value' && a.value === value) || (a.type === 'values' && (a.values ?? []).includes(value)),
	)
}

const queueLength = (s: any) => s.queue.layerList.length as number
const queueOrder = (s: any) => s.queue.layerList.map((it: any) => it.itemId).join(',') as string

export const steps = Tour.defineSteps([
	{ id: 'welcome', msg: TUT_Msgs.welcome, advance: { type: 'next' } },
	{ id: 'queue-panel', anchor: 'queue-panel', msg: TUT_Msgs.queuePanel, advance: { type: 'next' } },
	// read-only tour of the head item's display, before any editing. The command card is built from the live head
	// item, so it shows the exact AdminSetNextLayer the spotlighted layer stands for.
	{
		id: 'layer-command',
		anchor: 'queue-layer-name',
		msg: {
			inputs: (run) => [run.squadServer],
			select: (s: any) => {
				const head = s.queue.layerList[0]
				const cmd = head ? L.getLayerCommand(head.layerId, 'set-next') : ''
				const [cmdName, map, team1, team2] = cmd.split(' ')
				return {
					title: tr.text(TUT_Msgs.layerCommand.title()),
					body: Tour.richText(TUT_Msgs.layerCommand.body(`${cmdName} ${map ?? ''}`, team1 ?? '', team2 ?? '')),
				}
			},
		},
		advance: { type: 'next' },
	},
	// the whole run of tagged rows, so the alternating (1)/(2) marks down the queue are visible in one zone
	{ id: 'team-normalize', anchor: { all: 'queue-item' }, msg: TUT_Msgs.teamNormalize, advance: { type: 'next' } },
	{ id: 'next-badge', anchor: 'queue-next-badge', spotlight: 'queue-item', msg: TUT_Msgs.nextBadge, advance: { type: 'next' } },
	{ id: 'start-editing', anchor: 'queue-edit', interact: 'anchor-only', msg: TUT_Msgs.openEditor, advance: { type: 'anchor' } },
	// the clear -> empty -> reset arc runs before any real edits exist, so Reset discards nothing the user built
	{
		id: 'clear-queue',
		anchor: 'queue-clear',
		interact: 'anchor-only',
		msg: TUT_Msgs.clearQueue,
		premise: editingQueue,
		advance: { type: 'state', inputs: (run) => [run.squadServer], select: (s: any) => queueLength(s) === 0 },
	},
	{
		id: 'queue-empty',
		anchor: 'queue-panel',
		msg: TUT_Msgs.queueEmpty,
		premise: editingQueue,
		advance: { type: 'next' },
	},
	{
		id: 'reset-queue',
		anchor: 'queue-reset',
		interact: 'anchor-only',
		msg: TUT_Msgs.resetQueue,
		premise: editingQueue,
		advance: { type: 'state', inputs: (run) => [run.squadServer], select: (s: any) => queueLength(s) > 0 },
	},
	{
		id: 'open-add',
		anchor: 'queue-add',
		interact: 'anchor-only',
		msg: TUT_Msgs.openAdd,
		premise: editingQueue,
		advance: { type: 'state', ...addDialogOpen },
	},
	{
		id: 'applied-filter',
		anchor: 'applied-filters',
		interact: 'free',
		msg: TUT_Msgs.appliedFilter,
		premise: addDialogOpen,
		advance: { type: 'next' },
	},
	{
		id: 'add-filters',
		anchor: 'add-filters',
		interact: 'free',
		msg: { title: TUT_Msgs.addFilters.title, body: () => TUT_Msgs.addFilters.body(ADD_TARGET.map, ADD_TARGET.faction) },
		premise: addDialogOpen,
		advance: {
			type: 'state',
			inputs: () => [addDialogFrame()],
			select: (s: any) => {
				const menu = s?.filterMenu?.menuItems
				if (!menu) return false
				return (
					compSelects(menu.Map, ADD_TARGET.map) &&
					(compSelects(menu.Faction_1, ADD_TARGET.faction) || compSelects(menu.Faction_2, ADD_TARGET.faction))
				)
			},
		},
	},
	{
		id: 'add-pick',
		anchor: 'add-pick',
		interact: 'free',
		msg: TUT_Msgs.addPick,
		premise: addDialogOpen,
		advance: {
			type: 'state',
			inputs: () => [addDialogFrame()],
			select: (s: any) => (s?.layerTable?.selected?.length ?? 0) > 0,
		},
	},
	{
		id: 'add-submit',
		anchor: 'add-submit',
		interact: 'free',
		msg: TUT_Msgs.addSubmit,
		premise: addDialogOpen,
		advance: { type: 'change', inputs: (run) => [run.squadServer], sample: queueLength, advanced: (from, to) => to > from },
	},
	// the layer just added is the new head: green mutation border, and now out of sync with the server
	{ id: 'added-highlight', anchor: 'queue-item', msg: TUT_Msgs.addedHighlight, premise: editingQueue, advance: { type: 'next' } },
	{
		id: 'not-next-badge',
		anchor: 'queue-next-badge',
		spotlight: 'queue-item',
		msg: TUT_Msgs.notNextBadge,
		premise: editingQueue,
		advance: { type: 'next' },
	},
	{
		id: 'remove-layer',
		anchor: 'queue-delete',
		spotlight: 'queue-item',
		interact: 'anchor-only',
		msg: TUT_Msgs.removeLayer,
		premise: editingQueue,
		advance: { type: 'anchor' },
	},
	{
		id: 'swap-factions',
		anchor: 'queue-swap',
		spotlight: 'queue-item',
		interact: 'anchor-only',
		msg: TUT_Msgs.swapFactions,
		premise: editingQueue,
		advance: { type: 'anchor' },
	},
	{
		id: 'reorder',
		anchor: 'queue-reorder',
		spotlight: 'queue-panel',
		interact: 'free',
		msg: TUT_Msgs.reorderLayer,
		premise: editingQueue,
		advance: { type: 'change', inputs: (run) => [run.squadServer], sample: queueOrder, advanced: (from, to) => from !== to },
	},
	{ id: 'save-queue', anchor: 'queue-save', interact: 'anchor-only', msg: TUT_Msgs.saveQueue, advance: { type: 'anchor' } },
	{ id: 'wrap-up', msg: TUT_Msgs.wrapUp, advance: { type: 'next' } },
])

Tour.registerScenario('layer-queue-basics', steps)
