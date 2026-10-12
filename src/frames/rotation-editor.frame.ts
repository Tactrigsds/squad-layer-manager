import * as LayerQueuePrt from '@/frame-partials/layer-queue.partial'
import * as ListHostPrt from '@/frame-partials/list-host.partial'
import type * as FRM from '@/lib/frame'
import * as Rx from '@/lib/rxjs'
import * as Zus from '@/lib/zustand'
import * as LQY from '@/models/layer-queries.models'
import * as RRS from '@/models/repeat-rulesets.models'
import type * as ROT from '@/models/rotations.models'
import * as SETTINGS from '@/models/settings.models'
import * as RotationClient from '@/systems/rotation.client'
import * as SettingsClient from '@/systems/settings.client'

import { frameManager } from './frame-manager'

// The list host for one rotation's page: the shared draft of its items (edited with the queue's list editor) and the
// statuses shown on them. A rotation has no server, so it has no match history, and the catalog stands in for a
// server's settings; its repeat rules are those of its ruleset.

export type Input = { rotationId: ROT.RotationId }

export type State = ListHostPrt.Store & {
	rotationId: ROT.RotationId
}

export type Types = {
	name: 'rotationEditor'
	key: FRM.RawInstanceKey<{ rotationId: ROT.RotationId }>
	input: Input
	state: State
}

export type Key = FRM.InstanceKey<Types>
export type KeyProp = { rotationEditor: Key }
export type Frame = FRM.Frame<Types>

export function createInput(rotationId: ROT.RotationId): Input {
	return { rotationId }
}

export const frame: Frame = frameManager.createFrame<Types>({
	name: 'rotationEditor',
	createKey: (frameId, input) => ({ frameId, rotationId: input.rotationId }),
	setup(args) {
		const { rotationId } = args.input
		LayerQueuePrt.initLayerQueue(args, { type: 'rotation', rotationId })
		args.set({
			...ListHostPrt.INITIAL,
			rotationId,
			listHost: { type: 'rotation', rotationId },
			settings: { saved: SETTINGS.catalogSettings() },
		})

		const state$ = Zus.toObservable(args.key, true)
		args.cleanup.push(
			state$
				.pipe(
					Rx.map(([state]) => state.queue.layerList),
					Rx.distinctUntilChanged(),
				)
				.subscribe((list) => args.set({ layerItemsState: LQY.resolveLayerItemsState(list, []) })),
		)

		args.cleanup.push(
			Rx.combineLatest([
				Zus.toStream(RotationClient.Store, (s) => s.rotations.get(rotationId)?.repeatRulesetId ?? null, { fireImmediately: true }),
				Zus.toStream(SettingsClient.PublicSettingsStore, SettingsClient.selectRepeatRulesets, { fireImmediately: true }),
			]).subscribe(([repeatRulesetId, rulesets]) => args.set({ repeatRules: [...RRS.rulesFor(rulesets, repeatRulesetId)] })),
		)

		ListHostPrt.initStatuses(args)
	},
})
