import { globalToast$ } from '@/hooks/use-global-toast'
import type * as FRM from '@/lib/frame'
import * as Obj from '@/lib/object'
import { devValidate } from '@/lib/zod.dev'
import * as ZusUtils from '@/lib/zustand'
import * as SS from '@/models/server-state.models'
import * as SETTINGS from '@/models/settings.models'
import * as RPC from '@/orpc.client'
import * as RbacClient from '@/systems/rbac.client'
import * as Im from 'immer'
import { z } from 'zod'

export type Store = {
	settings: SettingsPartial
}
export type Key = FRM.InstanceKeyOfState<Store>
export type KeyProp = { settings: Key }

export type SettingsPartial = {
	serverId: string
	ops: SETTINGS.SettingMutation[]
	modified: boolean
	saved: SETTINGS.PublicServerSettings
	edited: SETTINGS.PublicServerSettings
	saving: boolean

	validationErrors: null | string[]
}

export type Args = FRM.SetupArgs<{ serverId: string }, Store, Store>

export function initServerSettings(args: Args) {
	const serverId = args.input.serverId
	const defaultSettings = SETTINGS.PublicServerSettingsSchema.parse({})

	const set = ZusUtils.toPartialSetter(args.set, 'settings')
	const get = ZusUtils.toPartialGetter(args.get, 'settings')

	set(
		{
			serverId,
			ops: [],
			saving: false,
			modified: false,

			saved: defaultSettings,
			edited: defaultSettings,
			validationErrors: null,
		} satisfies SettingsPartial,
	)

	args.sub.add(
		args.update$.subscribe(([storeState, storePrevState]) => {
			const state = storeState.settings
			const prevState = storePrevState.settings
			const modified = !Obj.deepEqual(state.edited, state.saved)
			if (modified !== state.modified) {
				set({ modified })
			}
			if (state.edited !== prevState.edited) {
				const parseRes = SETTINGS.PublicServerSettingsSchema.safeParse(state.edited)
				if (!parseRes.success) {
					set({ validationErrors: [z.prettifyError(parseRes.error)] })
				} else {
					set({ validationErrors: null })
				}
			}
		}),
	)

	args.sub.add(
		RPC.observe(() => RPC.orpc.settings.server.watchSettings.call({ serverId })).subscribe(([settings, source]) => {
			const updated = Obj.structuralMerge(get().saved, settings)
			set({ saved: updated, edited: updated, ops: [] })
			if (source) {
				globalToast$.next({ title: SS.printSource(source) })
			}
		}),
	)
}

export namespace Sel {
	export function saved(store: Store) {
		return store.settings.saved
	}
	export function edited(store: Store) {
		return store.settings.edited
	}
	export function modified(store: Store) {
		return store.settings.modified
	}
	export function validationErrors(store: Store) {
		return store.settings.validationErrors
	}
}

export namespace Actions {
	export function set(stores: KeyProp, mut: SETTINGS.SettingMutation) {
		devValidate(SETTINGS.SettingMutationSchema, mut)
		ZusUtils.toPartialStore(stores.settings, 'settings').setState(state =>
			Im.produce(state, draft => {
				SETTINGS.applySettingMutation(draft.edited, mut)
				draft.ops.push(mut)
			})
		)
	}

	export async function save(stores: KeyProp): Promise<boolean> {
		const slice = ZusUtils.toPartialStore(stores.settings, 'settings')
		try {
			slice.setState({ saving: true })
			const { serverId, ops } = slice.getState()
			const res = await RPC.orpc.settings.server.updateSettings.call({ serverId, ops })
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
			slice.setState({ saving: false })
		}
	}

	export function reset(stores: KeyProp) {
		ZusUtils.toPartialStore(stores.settings, 'settings').setState(state => ({ edited: state.saved, ops: [] }))
	}
}
