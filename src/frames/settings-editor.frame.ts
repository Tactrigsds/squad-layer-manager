import type { z } from 'zod'

import type * as FRM from '@/lib/frame'
import * as Obj from '@/lib/object-utils'
import * as Rx from '@/lib/rxjs'
import type { SettingChange } from '@/lib/settings-diff'
import { diffSettings } from '@/lib/settings-diff'
import { toast } from '@/lib/toast'
import * as Zus from '@/lib/zustand'
import * as SETTINGS_Msgs from '@/messages/settings.messages'
import * as SS from '@/models/server-state.models'
import * as SETTINGS from '@/models/settings.models'
import * as RPC from '@/orpc.client'
import * as RBAC from '@/rbac.models'
import { tr } from '@/systems/messages.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SettingsClient from '@/systems/settings.client'

import { frameManager } from './frame-manager'

// One frame instance per editable section of the settings page (global settings, each server, the new-server form).
// The frame is the source of truth for the section's draft/mode/save state; components read via selectors and write
// through Actions, so nothing needs to mirror render output into a store. Derived fields (changes/issues/valid) are
// maintained by the frame's own update$ subscription, same as server-settings.partial does for modified/validationErrors.

const NO_ISSUES: never[] = []
const NO_PATHS: never[] = []

export type Kind = 'global' | 'server' | 'new-server'

// pageId is minted per settings-page mount so every visit gets fresh instances (and a fresh raw-settings fetch);
// nonce distinguishes successive "Add Managed Server" attempts within one visit
export type Input = { pageId: string } & ({ kind: 'global' } | { kind: 'server'; serverId: string } | { kind: 'new-server'; nonce: string })

export type SettingsEditor = {
	sub: Rx.Subscription
	kind: Kind
	serverId: string | null
	mode: 'gui' | 'yaml'
	// tells the form's uncontrolled inputs to re-read after a programmatic draft change (reset, yaml->gui carry-over)
	reset$: Rx.Subject<void>

	// encoded/input-shape values; draft is what the GUI form edits, saved is the reset/diff baseline
	saved?: any
	draft?: any
	// the latest valid, decoded value from the YAML editor while in YAML mode; null while the buffer is invalid
	yamlValid: any

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

// minimal input-shape seed for a brand-new server. Typed as the schema's input so the seed is checked against it:
// prefaulted fields (queue, the rest of the public settings) may be omitted and are filled in at save time.
export const NEW_SERVER_DRAFT: z.input<typeof SETTINGS.ServerSettingsSchema> = {
	connections: {
		type: 'local',
		logFile: '',
		rcon: { host: '', port: 21114, password: '' },
	},
	adminLists: [],
}

function editSchema(state: SettingsEditor): z.ZodType<any> {
	if (state.kind === 'global') return SETTINGS.GlobalSettingsSchema
	return state.sensitiveOmitted ? SETTINGS.ServerSettingsNoConnectionsSchema : SETTINGS.ServerSettingsSchema
}

// The pending value in the encoded/input shape (same shape as `saved`), for diffing against the baseline. `saved` is
// always `encode(parse(...))`, so the draft has to be normalized the same way: a field the GUI omits because it is empty
// (a role with no assignments, a settings grant with no paths) comes back prefaulted from the server and would otherwise
// read as a change no save can ever clear. A draft that doesn't parse has nothing to normalize through, so it diffs raw.
function nextEncoded(state: SettingsEditor, value: any): any {
	const raw = state.mode === 'gui' ? state.draft : undefined
	if (value === null || value === undefined) return raw
	try {
		return editSchema(state).encode(value)
	} catch {
		return raw
	}
}

// A form always edits the encoded/input shape, so a HumanTime reads "5s" rather than 5000 whichever settings scope it
// belongs to. Global settings are already stored that way; server settings are stored decoded, so they're encoded on
// load. Settings that don't parse are the repair flow: hand those through untouched for the YAML editor to fix.
function toEditShape(schema: z.ZodType<any>, raw: unknown): unknown {
	const parsed = schema.safeParse(raw)
	if (!parsed.success) return raw
	try {
		return schema.encode(parsed.data)
	} catch {
		return raw
	}
}

// the decoded value a save would submit (null when invalid): the gui draft parsed, or the YAML editor's latest valid value
function validValue(state: SettingsEditor): any {
	if (state.mode === 'yaml') return state.yamlValid
	if (state.draft === undefined) return null
	const res = editSchema(state).safeParse(state.draft)
	return res.success ? res.data : null
}

export function deriveComputed(state: SettingsEditor): Pick<SettingsEditor, 'changes' | 'issues' | 'valid'> {
	const guiRes = state.mode === 'gui' && state.draft !== undefined ? editSchema(state).safeParse(state.draft) : undefined
	const issues = guiRes && !guiRes.success ? guiRes.error.issues : NO_ISSUES
	const value = state.mode === 'yaml' ? state.yamlValid : guiRes?.success ? guiRes.data : null
	if (state.kind === 'new-server') {
		return {
			changes: diffSettings({}, { id: state.newId, displayName: state.newDisplayName, ...(value ?? {}) }),
			issues,
			valid: SS.ServerIdSchema.safeParse(state.newId).success && state.newDisplayName.trim().length > 0 && value !== null,
		}
	}
	const nextEnc = nextEncoded(state, value)
	return {
		changes: state.saved !== undefined && nextEnc !== undefined ? diffSettings(state.saved, nextEnc) : [],
		issues,
		valid: value !== null,
	}
}

const setup: Frame['setup'] = (args) => {
	const input = args.input
	const get = args.get
	const set = args.set as Zus.Setter<SettingsEditor>

	const isNew = input.kind === 'new-server'
	set({
		sub: new Rx.Subscription(),
		kind: input.kind,
		serverId: input.kind === 'server' ? input.serverId : null,
		mode: 'gui',
		reset$: new Rx.Subject<void>(),
		saved: isNew ? NEW_SERVER_DRAFT : undefined,
		draft: isNew ? Obj.deepClone(NEW_SERVER_DRAFT) : undefined,
		yamlValid: isNew ? Obj.deepClone(NEW_SERVER_DRAFT) : null,
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
	} satisfies SettingsEditor)

	// keep the derived fields current; guarded on the source fields so writing them back doesn't loop
	args.cleanup.push(
		args.update$.subscribe(([state, prev]) => {
			if (
				state.draft !== prev.draft ||
				state.yamlValid !== prev.yamlValid ||
				state.mode !== prev.mode ||
				state.saved !== prev.saved ||
				state.sensitiveOmitted !== prev.sensitiveOmitted ||
				state.newId !== prev.newId ||
				state.newDisplayName !== prev.newDisplayName
			) {
				set(deriveComputed(state))
			}
		}),
	)

	if (input.kind === 'global') {
		args.cleanup.push(
			SettingsClient.globalSettings$.subscribe((raw) => {
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
			}),
		)
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
	const schema = res.sensitiveOmitted ? SETTINGS.ServerSettingsNoConnectionsSchema : SETTINGS.ServerSettingsSchema
	const settings = toEditShape(schema, res.settings)
	set({ loading: false, loadFailed: null, sensitiveOmitted: res.sensitiveOmitted, saved: settings })
	if (opts.seedDraft && get().draft === undefined) set({ draft: settings })
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

	// what the page as a whole needs from its sections: `newServerCreated` collapses the new-server form once its save
	// lands (the created server then renders as a regular section via the public-settings watch)
	export function pageStatus(...states: SettingsEditor[]) {
		let newServerCreated = false
		let anyDirty = false
		for (const s of states) {
			if (s.kind === 'new-server' && s.created) newServerCreated = true
			if (dirty(s)) anyDirty = true
		}
		return { newServerCreated, anyDirty }
	}

	// the per-section editor modes the table of contents keys off: a YAML-mode section renders no per-field anchors,
	// so it collapses to a single leaf there
	export function tocModes(...states: SettingsEditor[]) {
		const serverModes: Record<string, 'gui' | 'yaml'> = {}
		let globalMode: 'gui' | 'yaml' = 'gui'
		let newServerMode: 'gui' | 'yaml' = 'gui'
		let creatingServer = false
		for (const s of states) {
			if (s.kind === 'server') serverModes[s.serverId!] = s.mode
			else if (s.kind === 'global') globalMode = s.mode
			else {
				newServerMode = s.mode
				creatingServer = !s.created
			}
		}
		return { serverModes, globalMode, newServerMode, creatingServer }
	}
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
	// connections paths are gated by write-sensitive, not by path grants; a sensitive user's connection edits are always
	// allowed (and connections can't appear in the diff at all without it, since they're redacted on read)
	const write = RBAC.serverSettingsWriteAccess(perms, state.serverId!, RBAC.NO_SCOPED_SERVERS)
	if (write.kind === 'all') return NO_PATHS
	const sensitive = RBAC.canWriteSensitiveServerSettings(perms, state.serverId!, RBAC.NO_SCOPED_SERVERS)
	const isConnection = (p: string) => p === 'connections' || p.startsWith('connections.')
	const paths = state.changes.map((c) => c.path).filter((p) => !(sensitive && isConnection(p)))
	if (write.kind === 'none') return paths
	return paths.filter((p) => !isConnection(p)).filter((p) => !RBAC.settingsPathAllowed(write, p))
}

export namespace Actions {
	function store(stores: KeyProp) {
		return Zus.resolveStore<SettingsEditor>(stores.settingsEditor)
	}

	export function setDraft(stores: KeyProp, draft: any) {
		store(stores).setState({ draft })
	}

	export function setYamlValid(stores: KeyProp, yamlValid: any) {
		store(stores).setState({ yamlValid })
	}

	export function setNewServerFields(stores: KeyProp, fields: { id?: string; displayName?: string }) {
		store(stores).setState({
			...(fields.id !== undefined ? { newId: fields.id } : {}),
			...(fields.displayName !== undefined ? { newDisplayName: fields.displayName } : {}),
		})
	}

	export function setMode(stores: KeyProp, next: 'gui' | 'yaml') {
		const s = store(stores)
		const state = s.getState()
		if (state.mode === next) return
		if (next === 'yaml') {
			// seed the YAML editor's notion of validity from the current gui draft
			const parsed = state.draft !== undefined ? editSchema(state).safeParse(state.draft) : undefined
			s.setState({ mode: 'yaml', yamlValid: parsed?.success ? parsed.data : null })
		} else {
			if (state.yamlValid !== null) {
				// carry YAML edits back into the gui draft (re-encode to the input shape); reset$ makes the gui re-read
				const enc = editSchema(state).encode(state.yamlValid)
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
			s.setState({
				draft: Obj.deepClone(NEW_SERVER_DRAFT),
				yamlValid: Obj.deepClone(NEW_SERVER_DRAFT),
				newId: '',
				newDisplayName: '',
			})
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
						toast.error(...tr.toast(SETTINGS_Msgs.invalid(res.message)))
						return false
					}
					// the watchSettings subscription delivers the new baseline; the draft is left as-is and rediffs to clean
					toast(...tr.toast(SETTINGS_Msgs.saved()))
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
						toast.error(...tr.toast(SETTINGS_Msgs.invalid(res.message)))
						return false
					}
					if (res.code === 'err:server-not-found') {
						toast.error(...tr.toast(SETTINGS_Msgs.serverNotFound()))
						return false
					}
					toast(...tr.toast(SETTINGS_Msgs.serverSettingsSaved()))
					// refresh the baseline with the server-normalized value; only re-seed the draft if no edits landed mid-save
					const draftAtSave = state.draft
					await loadServerSettings(
						() => s.getState(),
						(p) => s.setState(p),
						state.serverId!,
						{ seedDraft: false },
					)
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
						toast.error(...tr.toast(SETTINGS_Msgs.serverIdTaken()))
						return false
					}
					if (res.code === 'err:invalid-settings') {
						toast.error(...tr.toast(SETTINGS_Msgs.invalid(res.message)))
						return false
					}
					toast(...tr.toast(SETTINGS_Msgs.serverCreated()))
					s.setState({ created: true })
					return true
				}
			}
		} finally {
			s.setState({ saving: false })
		}
	}
}

// the section's draft as a value observable, which is how SettingsForm's fields read the document
export function draftValueState(key: Key): Zus.ValueObservable<any> {
	const store = Zus.resolveStore<SettingsEditor>(key)
	const obs = Zus.toObservable(store).pipe(
		Rx.map(([s]) => s.draft),
		Rx.distinctUntilChanged(),
	)
	return Object.assign(obs, { getValue: () => store.getState().draft })
}

// spelled as a selector rather than relying on the no-selector form, which hands back the bare state when a page
// happens to hold exactly one section
const asArray = (...states: SettingsEditor[]) => states

// the section states in key order; identity-cached by useStore so it doubles as a stable render input
export function useSectionStates(keys: Key[]): SettingsEditor[] {
	return Zus.useStore(...keys, asArray)
}
