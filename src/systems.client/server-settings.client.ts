import { globalToast$ } from '@/hooks/use-global-toast'

import * as Obj from '@/lib/object'
import { devValidate } from '@/lib/zod.dev'
import * as SS from '@/models/server-state.models'
import * as RPC from '@/orpc.client'
import * as RbacClient from '@/systems.client/rbac.client'
import * as ReactRx from '@react-rxjs/core'
import * as Im from 'immer'
import { z } from 'zod'
import * as Zus from 'zustand'

export const [useServerSettings, serverSettings$] = ReactRx.bind(RPC.observe(() => RPC.orpc.serverSettings.watchSettings.call()))

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

export const Store = createStore()

function createStore() {
	return Zus.createStore<EditSettingsStore>((set, get, store) => {
		const defaultSettings = SS.PublicServerSettingsSchema.parse({})
		store.subscribe((state, prevState) => {
			const modified = !Obj.deepEqual(state.edited, state.saved)
			if (modified !== state.modified) {
				store.setState({ modified })
			}
			if (state.edited !== prevState.edited) {
				const parseRes = SS.PublicServerSettingsSchema.safeParse(state.edited)
				if (!parseRes.success) {
					store.setState({ validationErrors: [z.prettifyError(parseRes.error)] })
				} else {
					store.setState({ validationErrors: null })
				}
			}
		})
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
					const res = await RPC.orpc.serverSettings.updateSettings.call(get().ops)
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
}

export function setup() {
	serverSettings$.subscribe(([settings]) => {
		const updated = Obj.structuralMerge(Store.getState().saved, settings)
		Store.setState({ saved: updated, edited: updated, ops: [] })
	})
}
