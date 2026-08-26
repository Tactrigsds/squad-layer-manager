import * as Im from 'immer'
import { z } from 'zod'

import type * as FRM from '@/lib/frame'
import * as Obj from '@/lib/object-utils'
import { toast } from '@/lib/toast'
import * as ZodDev from '@/lib/zod-utils.dev'
import * as Zus from '@/lib/zustand'
import * as SS_Msgs from '@/messages/server-state.messages'
import * as SETTINGS_Msgs from '@/messages/settings.messages'
import * as SETTINGS from '@/models/settings.models'
import * as RPC from '@/orpc.client'
import { tr } from '@/systems/messages.client'
import * as RbacClient from '@/systems/rbac.client'

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

	const set = Zus.toPartialSetter(args.set, 'settings')
	const get = Zus.toPartialGetter(args.get, 'settings')

	set({
		serverId,
		ops: [],
		saving: false,
		modified: false,

		saved: defaultSettings,
		edited: defaultSettings,
		validationErrors: null,
	} satisfies SettingsPartial)

	args.cleanup.push(
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

	args.cleanup.push(
		RPC.observe('settings.server.watchSettings', () => RPC.orpc.settings.server.watchSettings.call({ serverId }))
			.pipe(RPC.dropServerNotLoaded())
			.subscribe(([settings, source]) => {
				const updated = Obj.structuralMerge(get().saved, settings)
				set({ saved: updated, edited: updated, ops: [] })
				if (source) {
					toast(...tr.toast(SS_Msgs.stateUpdateSource(source)))
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
		ZodDev.devValidate(SETTINGS.SettingMutationSchema, mut)
		Zus.toPartialStore(stores.settings, 'settings').setState((state) =>
			Im.produce(state, (draft) => {
				SETTINGS.applySettingMutation(draft.edited, mut)
				draft.ops.push(mut)
			}),
		)
	}

	export async function save(stores: KeyProp): Promise<boolean> {
		const slice = Zus.toPartialStore(stores.settings, 'settings')
		try {
			slice.setState({ saving: true })
			const { serverId, ops } = slice.getState()
			const res = await RPC.orpc.settings.server.updateSettings.call({ serverId, ops })
			if (res?.code === 'err:permission-denied') {
				RbacClient.handlePermissionDenied(res)
				return false
			} else if (res?.code === 'err:invalid-settings') {
				toast.error(...tr.toast(SETTINGS_Msgs.invalid(res.message)))
				return false
			}
			return true
		} catch (err) {
			toast.error(...tr.toast(SETTINGS_Msgs.saveFailed(err instanceof Error ? err.message : String(err))))
			return false
		} finally {
			slice.setState({ saving: false })
		}
	}

	export function reset(stores: KeyProp) {
		Zus.toPartialStore(stores.settings, 'settings').setState((state) => ({ edited: state.saved, ops: [] }))
	}
}
