import * as TUT_Msgs from '@/messages/tutorials.messages'
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
const addDialogOpen: Tour.StateSelector<boolean> = {
	inputs: () => [UPClient.Store],
	select: (upState) =>
		UPClient.Sel.loadedActivities(upState).some(
			(e: any) => e.name === 'selectLayers' && e.active && e.data?.activity?.id === 'ADDING_ITEM',
		),
}

const queueLength = (s: any) => s.queue.layerList.length as number
const queueOrder = (s: any) => s.queue.layerList.map((it: any) => it.itemId).join(',') as string

export const steps = Tour.defineSteps([
	{ id: 'welcome', msg: TUT_Msgs.welcome, advance: { type: 'next' } },
	{ id: 'queue-panel', anchor: 'queue-panel', msg: TUT_Msgs.queuePanel, advance: { type: 'next' } },
	// read-only tour of the head item's display, before any editing
	{ id: 'team-slots', anchor: 'queue-layer-name', msg: TUT_Msgs.teamSlots, advance: { type: 'next' } },
	{ id: 'team-normalize', anchor: 'queue-layer-name', msg: TUT_Msgs.teamNormalize, advance: { type: 'next' } },
	{ id: 'next-badge', anchor: 'queue-next-badge', spotlight: 'queue-item', msg: TUT_Msgs.nextBadge, advance: { type: 'next' } },
	{ id: 'start-editing', anchor: 'queue-edit', interact: 'anchor-only', msg: TUT_Msgs.openEditor, advance: { type: 'anchor' } },
	{
		id: 'open-add',
		anchor: 'queue-add',
		interact: 'anchor-only',
		msg: TUT_Msgs.openAdd,
		premise: editingQueue,
		advance: { type: 'state', ...addDialogOpen },
	},
	{
		id: 'add-filters',
		anchor: 'add-filters',
		interact: 'free',
		msg: TUT_Msgs.addFilters,
		premise: addDialogOpen,
		advance: { type: 'next' },
	},
	{ id: 'add-pick', anchor: 'add-pick', interact: 'free', msg: TUT_Msgs.addPick, premise: addDialogOpen, advance: { type: 'next' } },
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
