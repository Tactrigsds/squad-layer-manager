import * as TUT_Msgs from '@/messages/tutorials.messages'
import * as Tour from '@/systems/tour.client'

// The client half of the layer-queue-basics tutorial: the step list the tour walks. This is a starter set matching
// the current server scenario's stages (welcome, play-a-match); the full 14-step journey follows once the server
// scenario grows its roll/vote stages. Importing this file registers the scenario with the engine.

export const steps = Tour.defineSteps([
	{ id: 'welcome', msg: TUT_Msgs.welcome, advance: { type: 'next' } },
	{ id: 'queue-panel', anchor: 'queue-panel', msg: TUT_Msgs.queuePanel, advance: { type: 'next' } },
	{ id: 'open-editor', anchor: 'queue-panel', interact: 'anchor-only', msg: TUT_Msgs.openEditor, advance: { type: 'next' } },
	{ id: 'play', anchor: 'server-activity', stage: 'play-a-match', msg: TUT_Msgs.rollEnding, advance: { type: 'next' } },
	{ id: 'wrap-up', msg: TUT_Msgs.wrapUp, advance: { type: 'next' } },
])

Tour.registerScenario('layer-queue-basics', steps)
