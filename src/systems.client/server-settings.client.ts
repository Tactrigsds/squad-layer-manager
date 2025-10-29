import { globalToast$ } from '@/hooks/use-global-toast'
import * as Obj from '@/lib/object'
import * as TrpcHelpers from '@/lib/trpc-helpers'
import { devValidate } from '@/lib/zod.dev'
import * as ZusUtils from '@/lib/zustand'
import * as SS from '@/models/server-state.models'
import * as RbacClient from '@/systems.client/rbac.client'
import { trpc } from '@/trpc.client'
import * as ReactRx from '@react-rxjs/core'
import * as Im from 'immer'
import * as Zus from 'zustand'

const [_useServerSettings, serverSettings$] = ReactRx.bind(TrpcHelpers.fromTrpcSub(undefined, trpc.serverSettings.watchSettings.subscribe))

export type EditSettingsStore = {
	ops: SS.SettingMutation[]
	modified: boolean
	saved: SS.PublicServerSettings
	edited: SS.PublicServerSettings
	set(mut: SS.SettingMutation): void
	saving: boolean
	save(): Promise<boolean>
	reset(): Promise<void>

	validationErrors: null | string[]
}

export const [Store, subHandle] = createStore()

function createStore() {
	const store = Zus.createStore<EditSettingsStore>((set, get) => {
		const defaultSettings = SS.PublicServerSettingsSchema.parse({})
		return {
			ops: [],
			saving: false,
			modified: false,

			saved: defaultSettings,
			edited: defaultSettings,
			validationErrors: null,

			set(mut) {
				devValidate(SS.SettingMutationSchema, mut)
				set(state =>
					Im.produce(state, draft => {
						SS.applySettingMutation(draft.edited, mut)
						draft.ops.push(mut)
					})
				)
			},

			async save() {
				try {
					set({ saving: true })
					const res = await trpc.serverSettings.updateSettings.mutate(get().ops)
					if (res?.code === 'err:permission-denied') {
						RbacClient.handlePermissionDenied(res)
						return false
					} else if (res?.code === 'err:invalid-settings') {
						globalToast$.next({
							variant: 'destructive',
							title: 'Error while saving settings:',
							description: res.message,
						})
						return false
					}
					return true
				} finally {
					set({ saving: false })
				}
			},

			async reset() {
				set(state => ({ edited: state.saved, ops: [] }))
			},
		}
	})

	const subHandle = ZusUtils.createSubHandle((subs) => {
		subs.push(serverSettings$.subscribe((settings) => {
			const updated = Obj.structuralMerge(store.getState().saved, settings)
			store.setState({ saved: updated, edited: updated, ops: [] })
		}))

		subs.push(store.subscribe((state, prevState) => {
			const modified = !Obj.deepEqual(state.edited, state.saved)
			if (modified !== state.modified) {
				store.setState({ modified })
			}
			if (state.edited !== prevState.edited) {
				const parseRes = SS.PublicServerSettingsSchema.safeParse(state.edited)
				if (!parseRes.success) {
					store.setState({ validationErrors: parseRes.error.errors.map(err => err.message) })
				} else {
					store.setState({ validationErrors: null })
				}
			}
		}))
	})

	return [store, subHandle] as const
}

export function setup() {
	subHandle.subscribe()
}
