import * as TUT_Msgs from '@/messages/tutorials.messages'
import * as Tour from '@/systems/tour.client'
import * as UPClient from '@/systems/user-presence.client'
import * as UsersClient from '@/systems/users.client'

// The client half of the layer-queue-basics tutorial: the step list the tour walks. It teaches the four queue edits
// -- add, remove, swap factions, reorder -- against the live dashboard. Importing this file registers the scenario
// with the engine.
//
// Interactive steps spotlight one control. remove and swap use interact:'anchor-only' with advance:'anchor': a
// single click does the edit and moves the tour on. add and reorder need the rest of the page (the Add Layers
// dialog, the drop targets), so they run interact:'free' and advance on the resulting change to the queue.

// the edit steps only make sense while the local client holds an editing session; if the user saves or exits, the
// tour regresses to start-editing (its anchor, Start Editing, is the nearest step without this premise)
const editingQueue: Tour.StateSelector<boolean> = {
	inputs: () => [UPClient.Store],
	select: (upState) => !!UsersClient.loggedInUserId && !!UPClient.Sel.isEditing(UsersClient.loggedInUserId)(upState),
}

const queueLength = (s: any) => s.queue.layerList.length as number
const queueOrder = (s: any) => s.queue.layerList.map((it: any) => it.itemId).join(',') as string

export const steps = Tour.defineSteps([
	{ id: 'welcome', msg: TUT_Msgs.welcome, advance: { type: 'next' } },
	{ id: 'queue-panel', anchor: 'queue-panel', msg: TUT_Msgs.queuePanel, advance: { type: 'next' } },
	{ id: 'start-editing', anchor: 'queue-edit', interact: 'anchor-only', msg: TUT_Msgs.openEditor, advance: { type: 'anchor' } },
	{
		id: 'add-layer',
		anchor: 'queue-add',
		interact: 'free',
		msg: TUT_Msgs.pickLayer,
		premise: editingQueue,
		advance: { type: 'change', inputs: (run) => [run.squadServer], sample: queueLength, advanced: (from, to) => to > from },
	},
	{
		id: 'remove-layer',
		anchor: 'queue-delete',
		interact: 'anchor-only',
		msg: TUT_Msgs.removeLayer,
		premise: editingQueue,
		advance: { type: 'anchor' },
	},
	{
		id: 'swap-factions',
		anchor: 'queue-swap',
		interact: 'anchor-only',
		msg: TUT_Msgs.swapFactions,
		premise: editingQueue,
		advance: { type: 'anchor' },
	},
	{
		id: 'reorder',
		anchor: 'queue-reorder',
		interact: 'free',
		msg: TUT_Msgs.reorderLayer,
		premise: editingQueue,
		advance: { type: 'change', inputs: (run) => [run.squadServer], sample: queueOrder, advanced: (from, to) => from !== to },
	},
	{ id: 'save-queue', anchor: 'queue-save', interact: 'anchor-only', msg: TUT_Msgs.saveQueue, advance: { type: 'anchor' } },
	{ id: 'wrap-up', msg: TUT_Msgs.wrapUp, advance: { type: 'next' } },
])

Tour.registerScenario('layer-queue-basics', steps)
