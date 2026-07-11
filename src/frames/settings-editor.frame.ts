import type * as FRM from '@/lib/frame'
import * as Obj from '@/lib/object'
import type { SettingChange } from '@/lib/settings-diff'
import { diffSettings } from '@/lib/settings-diff'
import { toast } from '@/lib/toast'
import * as ZusUtils from '@/lib/zustand'
import * as SS from '@/models/server-state.models'
import * as SETTINGS from '@/models/settings.models'
import * as RPC from '@/orpc.client'
import * as RBAC from '@/rbac.models'
import * as RbacClient from '@/systems/rbac.client'
import * as SettingsClient from '@/systems/settings.client'
import React from 'react'
import * as Rx from 'rxjs'
import type { z } from 'zod'
import { frameManager } from './frame-manager'

// One frame instance per editable section of the settings page (global settings, each server, the new-server form).
// The frame is the source of truth for the section's draft/mode/save state; components read via selectors and write
// through Actions, so nothing needs to mirror render output into a store. Derived fields (changes/issues/valid) are
// maintained by the frame's own update$ subscription, same as server-settings.partial does for modified/validationErrors.

const NO_ISSUES: never[] = []
const NO_PATHS: never[] = []

export type Kind = 'global' | 'server' | 'new-server'

// pageId is minted per settings-page mount so every visit gets fresh instances (and a fresh raw-settings fetch);
// nonce distinguishes successive "Add Server" attempts within one visit
export type Input =
	& { pageId: string }
	& ({ kind: 'global' } | { kind: 'server'; serverId: string } | { kind: 'new-server'; nonce: string })

export type SettingsEditor = {
	sub: Rx.Subscription
	kind: Kind
	serverId: string | null
	mode: 'gui' | 'json'
	// tells the form's uncontrolled inputs to re-read after a programmatic draft change (reset, json->gui carry-over)
	reset$: Rx.Subject<void>

	// encoded/input-shape values; draft is what the GUI form edits, saved is the reset/diff baseline
	saved?: any
	draft?: any
	// the latest valid, decoded value from the JSON editor while in JSON mode; null while the buffer is invalid
	jsonValid: any

	loading: boolean
	loadFailed: string | null
	// the global watch was denied (stale perms); the section renders a permission notice
	denied: boolean
	// server kind: connections were redacted, so edit/validate against the connections-free schema
	sensitiveOmitted: boolean
	saving: boolean

	// new-server kind
	newId: string
	newDisplayName: string
	created: boolean

	// derived from the fields above by the frame's update$ subscription
	changes: SettingChange[]
	issues: readonly z.core.$ZodIssue[]
	valid: boolean
}

export type Key = FRM.InstanceKey<Types>
export type KeyProp = FRM.KeyProp<Types>

export type Types = {
	name: 'settingsEditor'
	key: FRM.RawInstanceKey<{ kind: Kind; serverId?: string; pageId: string; nonce?: string }>
	input: Input
	state: SettingsEditor
}

export type Frame = FRM.Frame<Types>

// minimal input-shape seed for a brand-new server: the required-without-default fields (connections + admin lists).
// prefaulted fields (queue, public settings) are filled in by ServerSettingsSchema at save time.
export const NEW_SERVER_DRAFT: SETTINGS.ServerSettings = {
	connections: {
		rcon: { host: '', port: 21114, password: '' },
		logs: { type: 'log-receiver', token: 'dev' },
	},
	adminListSources: [],
	adminIdentifyingPermissions: ['canseeadminchat'],
} as unknown as SETTINGS.ServerSettings

function editSchema(state: SettingsEditor): z.ZodType<any> {
	if (state.kind === 'global') return SETTINGS.GlobalSettingsSchema
	return state.sensitiveOmitted ? SETTINGS.ServerSettingsNoConnectionsSchema : SETTINGS.ServerSettingsSchema
}

// the pending value in the encoded/input shape (same shape as `saved`), for diffing against the baseline
function nextEncoded(state: SettingsEditor): any {
	if (state.mode === 'gui') return state.draft
	if (state.jsonValid === null) return undefined
	return state.kind === 'global' ? SETTINGS.GlobalSettingsSchema.encode(state.jsonValid) : state.jsonValid
}

// the decoded value a save would submit (null when invalid): the gui draft parsed, or the JSON editor's latest valid value
function validValue(state: SettingsEditor): any {
	if (state.mode === 'json') return state.jsonValid
	if (state.draft === undefined) return null
	const res = editSchema(state).safeParse(state.draft)
	return res.success ? res.data : null
}

function deriveComputed(state: SettingsEditor): Pick<SettingsEditor, 'changes' | 'issues' | 'valid'> {
	const guiRes = state.mode === 'gui' && state.draft !== undefined ? editSchema(state).safeParse(state.draft) : undefined
	const issues = guiRes && !guiRes.success ? guiRes.error.issues : NO_ISSUES
	const value = state.mode === 'json' ? state.jsonValid : (guiRes?.success ? guiRes.data : null)
	if (state.kind === 'new-server') {
		return {
			changes: diffSettings({}, { id: state.newId, displayName: state.newDisplayName, ...(value ?? {}) }),
			issues,
			valid: SS.ServerIdSchema.safeParse(state.newId).success && state.newDisplayName.trim().length > 0 && value !== null,
		}
	}
	const nextEnc = nextEncoded(state)
	return {
		changes: state.saved !== undefined && nextEnc !== undefined ? diffSettings(state.saved, nextEnc) : [],
		issues,
		valid: value !== null,
	}
}

const setup: Frame['setup'] = (args) => {
	const input = args.input
	const get = args.get
	const set = args.set as ZusUtils.Setter<SettingsEditor>

	const isNew = input.kind === 'new-server'
	set(
		{
			sub: new Rx.Subscription(),
			kind: input.kind,
			serverId: input.kind === 'server' ? input.serverId : null,
			mode: 'gui',
			reset$: new Rx.Subject<void>(),
			saved: isNew ? NEW_SERVER_DRAFT : undefined,
			draft: isNew ? Obj.deepClone(NEW_SERVER_DRAFT) : undefined,
			jsonValid: isNew ? Obj.deepClone(NEW_SERVER_DRAFT) : null,
			loading: input.kind === 'server',
			loadFailed: null,
			denied: false,
			sensitiveOmitted: false,
			saving: false,
			newId: '',
			newDisplayName: '',
			created: false,
			changes: [],
			issues: NO_ISSUES,
			valid: false,
		} satisfies SettingsEditor,
	)

	// keep the derived fields current; guarded on the source fields so writing them back doesn't loop
	args.sub.add(args.update$.subscribe(([state, prev]) => {
		if (
			state.draft !== prev.draft || state.jsonValid !== prev.jsonValid || state.mode !== prev.mode
			|| state.saved !== prev.saved || state.sensitiveOmitted !== prev.sensitiveOmitted
			|| state.newId !== prev.newId || state.newDisplayName !== prev.newDisplayName
		) {
			set(deriveComputed(state))
		}
	}))

	if (input.kind === 'global') {
		args.sub.add(SettingsClient.globalSettings$.subscribe((raw) => {
			// the server denies the watch when the user lacks global-settings read access (e.g. stale perms after an
			// rbac change); refetching the logged-in user makes the route re-gate correctly
			if (raw && typeof raw === 'object' && 'code' in raw) {
				set({ denied: true })
				RbacClient.handlePermissionDenied(raw as RBAC.PermissionDeniedResponse)
				return
			}
			const settings = raw as SETTINGS.GlobalSettingsInput
			set({ denied: false, saved: settings })
			if (get().draft === undefined) set({ draft: settings })
		}))
	}

	if (input.kind === 'server') {
		void loadServerSettings(get, (p) => set(p), input.serverId, { seedDraft: true })
	}

	set(deriveComputed(get()))
}

async function loadServerSettings(
	get: () => SettingsEditor,
	set: (p: Partial<SettingsEditor>) => void,
	serverId: string,
	opts: { seedDraft: boolean },
) {
	const res = await RPC.orpc.settings.admin.getRawSettings.call({ serverId })
	if (!res || res.code !== 'ok') {
		set({ loading: false, loadFailed: res?.code ?? 'error' })
		return
	}
	set({ loading: false, loadFailed: null, sensitiveOmitted: res.sensitiveOmitted, saved: res.settings })
	if (opts.seedDraft && get().draft === undefined) set({ draft: res.settings })
}

export const frame = frameManager.createFrame<Types>({
	name: 'settingsEditor',
	setup,
	createKey: (frameId, input) => ({
		frameId,
		kind: input.kind,
		serverId: input.kind === 'server' ? input.serverId : undefined,
		pageId: input.pageId,
		nonce: input.kind === 'new-server' ? input.nonce : undefined,
	}),
})

export namespace Sel {
	export const schema = editSchema
	export const dirty = (s: SettingsEditor) =>
		s.kind === 'new-server' ? !s.created && (s.newId.trim().length > 0 || s.newDisplayName.trim().length > 0) : s.changes.length > 0
	// DOM anchor prefix matching what SettingsForm emits for this section
	export const idPrefix = (s: SettingsEditor) =>
		s.kind === 'global' ? 'setting:' : s.kind === 'server' ? `setting:server:${s.serverId}:` : 'setting:server:__new__:'
}

// changed paths outside the user's write grant: the client-side mirror of the server's enforcement (see
// settings.server.ts). Kept out of frame state because it depends on the (possibly role-simulated) client perms.
export function deniedSettingPaths(state: SettingsEditor, perms: RBAC.Permission[]): string[] {
	if (state.kind === 'new-server') return NO_PATHS
	if (state.kind === 'global') {
		const access = RBAC.globalSettingsWriteAccess(perms)
		if (access.kind === 'all') return NO_PATHS
		return state.changes.map((c) => c.path).filter((p) => !RBAC.settingsPathAllowed(access, p))
	}
	// connections paths are exempt from path checks server-side (they're gated by write-sensitive instead, and
	// can't appear in the diff without it)
	const write = RBAC.serverSettingsWriteAccess(perms, state.serverId!)
	if (write.kind === 'all') return NO_PATHS
	const paths = state.changes.map((c) => c.path)
	if (write.kind === 'none') return paths
	return paths
		.filter((p) => p !== 'connections' && !p.startsWith('connections.'))
		.filter((p) => !RBAC.settingsPathAllowed(write, p))
}

export namespace Actions {
	function store(stores: KeyProp) {
		return ZusUtils.resolveStore<SettingsEditor>(stores.settingsEditor)
	}

	export function setDraft(stores: KeyProp, draft: any) {
		store(stores).setState({ draft })
	}

	export function setJsonValid(stores: KeyProp, jsonValid: any) {
		store(stores).setState({ jsonValid })
	}

	export function setNewServerFields(stores: KeyProp, fields: { id?: string; displayName?: string }) {
		store(stores).setState({
			...(fields.id !== undefined ? { newId: fields.id } : {}),
			...(fields.displayName !== undefined ? { newDisplayName: fields.displayName } : {}),
		})
	}

	export function setMode(stores: KeyProp, next: 'gui' | 'json') {
		const s = store(stores)
		const state = s.getState()
		if (state.mode === next) return
		if (next === 'json') {
			// seed the JSON editor's notion of validity from the current gui draft
			const parsed = state.draft !== undefined ? editSchema(state).safeParse(state.draft) : undefined
			s.setState({ mode: 'json', jsonValid: parsed?.success ? parsed.data : null })
		} else {
			if (state.jsonValid !== null) {
				// carry JSON edits back into the gui draft (re-encode to the input shape); reset$ makes the gui re-read
				const enc = state.kind === 'global' ? SETTINGS.GlobalSettingsSchema.encode(state.jsonValid) : state.jsonValid
				s.setState({ mode: 'gui', draft: enc })
				state.reset$.next()
			} else {
				s.setState({ mode: 'gui' })
			}
		}
	}

	export function resetDraft(stores: KeyProp) {
		const s = store(stores)
		const state = s.getState()
		if (state.kind === 'new-server') {
			s.setState({ draft: Obj.deepClone(NEW_SERVER_DRAFT), jsonValid: Obj.deepClone(NEW_SERVER_DRAFT), newId: '', newDisplayName: '' })
			state.reset$.next()
			return
		}
		if (state.saved === undefined) return
		s.setState({ draft: state.saved })
		state.reset$.next()
	}

	export async function save(stores: KeyProp): Promise<boolean> {
		const s = store(stores)
		const state = s.getState()
		const value = validValue(state)
		if (value === null || state.saving) return false
		try {
			s.setState({ saving: true })
			switch (state.kind) {
				case 'global': {
					const res = await RPC.orpc.settings.global.updateSettings.call(value)
					if (!res) return false
					if (res.code === 'err:permission-denied') {
						RbacClient.handlePermissionDenied(res)
						return false
					}
					if (res.code === 'err:invalid-settings') {
						toast.error('Invalid settings', { description: res.message })
						return false
					}
					// the watchSettings subscription delivers the new baseline; the draft is left as-is and rediffs to clean
					toast('Settings saved')
					return true
				}
				case 'server': {
					const res = await RPC.orpc.settings.admin.updateRawSettings.call({ serverId: state.serverId!, settings: value })
					if (!res) return false
					if (res.code === 'err:permission-denied') {
						RbacClient.handlePermissionDenied(res)
						return false
					}
					if (res.code === 'err:invalid-settings') {
						toast.error('Invalid settings', { description: res.message })
						return false
					}
					if (res.code === 'err:server-not-found') {
						toast.error('Server not found')
						return false
					}
					toast('Server settings saved')
					// refresh the baseline with the server-normalized value; only re-seed the draft if no edits landed mid-save
					const draftAtSave = state.draft
					await loadServerSettings(() => s.getState(), (p) => s.setState(p), state.serverId!, { seedDraft: false })
					const cur = s.getState()
					if (cur.draft === draftAtSave && cur.saved !== undefined) {
						s.setState({ draft: cur.saved })
						cur.reset$.next()
					}
					return true
				}
				case 'new-server': {
					if (!SS.ServerIdSchema.safeParse(state.newId).success || !state.newDisplayName.trim()) return false
					const res = await RPC.orpc.settings.admin.createServer.call({
						id: state.newId,
						displayName: state.newDisplayName.trim(),
						settings: value,
					})
					if (!res) return false
					if (res.code === 'err:permission-denied') {
						RbacClient.handlePermissionDenied(res)
						return false
					}
					if (res.code === 'err:server-already-exists') {
						toast.error('A server with that ID already exists')
						return false
					}
					if (res.code === 'err:invalid-settings') {
						toast.error('Invalid settings', { description: res.message })
						return false
					}
					toast('Server created')
					s.setState({ created: true })
					return true
				}
			}
		} finally {
			s.setState({ saving: false })
		}
	}
}

// a ValueState (Rx.Observable + getValue) over the section's draft, for SettingsForm's uncontrolled-input data flow
export function draftValueState(key: Key): Rx.Observable<any> & { getValue: () => any } {
	const store = ZusUtils.resolveStore<SettingsEditor>(key)
	const obs = ZusUtils.toObservable(store).pipe(
		Rx.map(([s]) => s.draft),
		Rx.distinctUntilChanged(),
	)
	return Object.assign(obs, { getValue: () => store.getState().draft })
}

// subscribe to a dynamic list of section instances and derive a combined value; the snapshot is cached on the
// section states' identities so an unrelated render never produces a fresh (tearing) result
export function useCombinedSections<R>(keys: Key[], combine: (states: SettingsEditor[]) => R): R {
	const stores = React.useMemo(() => keys.map((k) => ZusUtils.resolveStore<SettingsEditor>(k)), [keys])
	const combineRef = React.useRef(combine)
	combineRef.current = combine
	const cache = React.useRef<{ states: SettingsEditor[]; result: R } | null>(null)
	const subscribe = React.useCallback((cb: () => void) => {
		const unsubs = stores.map((s) => s.subscribe(cb))
		return () => unsubs.forEach((u) => u())
	}, [stores])
	const getSnapshot = React.useCallback(() => {
		const states = stores.map((s) => s.getState())
		const c = cache.current
		if (c && c.states.length === states.length && c.states.every((s, i) => s === states[i])) return c.result
		const result = combineRef.current(states)
		cache.current = { states, result }
		return result
	}, [stores])
	return React.useSyncExternalStore(subscribe, getSnapshot)
}

// the section states in key order; identity-cached so it doubles as a stable render input
export function useSectionStates(keys: Key[]): SettingsEditor[] {
	return useCombinedSections(keys, (states) => states)
}
