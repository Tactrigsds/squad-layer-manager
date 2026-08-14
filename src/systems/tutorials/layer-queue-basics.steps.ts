import * as TUT_Msgs from '@/messages/tutorials.messages'
import * as Tour from '@/systems/tour.client'

// The client half of the layer-queue-basics tutorial: the step list the tour walks. Starter set for the current
// server scenario; the full 14-step journey follows once the server scenario grows its roll/vote stages. Importing
// this file registers the scenario with the engine.
//
// The interactive steps (start-editing, save-queue) spotlight one specific control with interact:'anchor-only', so
// only that control is live, and advance:'anchor' means the tour moves on the instant the user activates it.

export const steps = Tour.defineSteps([
	{ id: 'welcome', msg: TUT_Msgs.welcome, advance: { type: 'next' } },
	{ id: 'queue-panel', anchor: 'queue-panel', msg: TUT_Msgs.queuePanel, advance: { type: 'next' } },
	{ id: 'start-editing', anchor: 'queue-edit', interact: 'anchor-only', msg: TUT_Msgs.openEditor, advance: { type: 'anchor' } },
	{ id: 'save-queue', anchor: 'queue-save', interact: 'anchor-only', msg: TUT_Msgs.saveQueue, advance: { type: 'anchor' } },
	{ id: 'wrap-up', msg: TUT_Msgs.wrapUp, advance: { type: 'next' } },
])

Tour.registerScenario('layer-queue-basics', steps)
