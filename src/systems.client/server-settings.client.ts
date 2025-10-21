import * as Obj from '@/lib/object'
import * as TrpcHelpers from '@/lib/trpc-helpers'
import * as SS from '@/models/server-state.models'
import { trpc } from '@/trpc.client'
import * as ReactRx from '@react-rxjs/core'
import * as Zus from 'zustand'

const [_useSettings, settings$] = ReactRx.bind(TrpcHelpers.fromTrpcSub(undefined, trpc.serverSettings.watchSettings.subscribe))

export type EditSettingsStore = {
	ops: SS.SettingMutation[]
	modified: boolean
	saved: SS.PublicServerSettings
	edited: SS.PublicServerSettings
	set(mut: SS.SettingMutation): void
	saving: boolean
	save(): Promise<void>
}

export const Store = Zus.createStore<EditSettingsStore>((set, get) => {
	settings$.subscribe((settings) => {
		const updated = Obj.structuralMerge(get().saved, settings)
		set({ saved: updated, edited: updated, modified: !Obj.deepEqual(settings, updated) })
	})

	const defaultSettings = SS.PublicServerSettingsSchema.parse({})
	return {
		ops: [],
		saving: false,
		modified: false,

		saved: defaultSettings,
		edited: defaultSettings,

		set(mut) {
			const state = get()
			if (!state.saved) return
			const edited = Obj.deepClone(state.edited ?? state.saved)
			SS.applySettingMutations(edited, [mut])
			set({ ops: [...state.ops, mut], edited })
		},

		async save() {
			try {
				set({ saving: true })
				await trpc.serverSettings.updateSettings.mutate(get().ops)
			} finally {
				set({ saving: false })
			}
		},
	}
})
