import * as Obj from '@/lib/object'
import * as TrpcHelpers from '@/lib/trpc-helpers'
import * as ZusUtils from '@/lib/zustand'
import * as SS from '@/models/server-state.models'
import { trpc } from '@/trpc.client'
import * as ReactRx from '@react-rxjs/core'
import * as Zus from 'zustand'
import { storeSubHandle } from './shared-layer-list.client'

const [_useSettings, serverSettings$] = ReactRx.bind(TrpcHelpers.fromTrpcSub(undefined, trpc.serverSettings.watchSettings.subscribe))

export type EditSettingsStore = {
	ops: SS.SettingMutation[]
	modified: boolean
	saved: SS.PublicServerSettings
	edited: SS.PublicServerSettings
	set(mut: SS.SettingMutation): void
	saving: boolean
	save(): Promise<void>
	reset(): Promise<void>
}

export const [Store, subHandle] = createStore()

function createStore() {
	let subHandle!: ZusUtils.SubHandle
	const store = Zus.createStore<EditSettingsStore>((set, get, store) => {
		subHandle = ZusUtils.createSubHandle((subs) => {
			subs.push(serverSettings$.subscribe((settings) => {
				const updated = Obj.structuralMerge(get().saved, settings)
				set({ saved: updated, edited: updated, modified: !Obj.deepEqual(settings, updated) })
			}))

			subs.push(store.subscribe(state => {
				const modified = !Obj.deepEqual(state.edited, state.saved)
				if (modified !== state.modified) {
					set({ modified })
				}
			}))
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

			async reset() {
				set(state => ({ edited: state.saved }))
			},
		}
	})

	return [store, subHandle] as const
}

export function settings() {
	storeSubHandle.subscribe()
}
