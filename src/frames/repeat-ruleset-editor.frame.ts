import type * as ServerSettingsPrt from '@/frame-partials/server-settings.partial'
import type * as FRM from '@/lib/frame'
import * as Obj from '@/lib/object-utils'
import * as Rx from '@/lib/rxjs'
import { toast } from '@/lib/toast'
import { assertNever } from '@/lib/type-guards'
import * as Zus from '@/lib/zustand'
import * as SETTINGS_Msgs from '@/messages/settings.messages'
import * as RRS from '@/models/repeat-rulesets.models'
import type * as ROT from '@/models/rotations.models'
import type * as SETTINGS from '@/models/settings.models'
import * as RPC from '@/orpc.client'
import { tr } from '@/systems/messages.client'
import * as RbacClient from '@/systems/rbac.client'
import * as RotationClient from '@/systems/rotation.client'
import * as SettingsClient from '@/systems/settings.client'

import { frameManager } from './frame-manager'

// A draft of the rules of one ruleset, for the editors that sit beside whatever chooses the ruleset: the pool
// configuration window, the settings page's server form and the rotation editor. The ruleset follows that chooser's
// (unsaved) choice, so picking another ruleset there swaps the rules being edited here.
//
// The draft re-seeds from the saved ruleset whenever the choice changes, and when someone else saves the ruleset
// while the draft holds no edits. A draft with edits is kept, and flagged as conflicting, so saving it is a choice to
// overwrite theirs.

export type Source =
	// the repeatRulesetId in the edited (unsaved) settings of a server
	| { type: 'server'; settingsKey: ServerSettingsPrt.Key }
	// the repeatRulesetId in a pool configuration draft (queue.mainPool), as the settings page's form holds it
	| { type: 'pool-draft'; value$: Rx.Observable<{ repeatRulesetId?: RRS.RulesetId | null } | undefined> }
	// a rotation's saved repeatRulesetId
	| { type: 'rotation'; rotationId: ROT.RotationId }

export type Input = { source: Source }

export type Store = {
	repeatRulesetId: RRS.RulesetId | null
	// the ruleset as last saved; undefined when the id resolves to nothing
	saved: RRS.Ruleset | undefined
	// the saved rules the draft started from, which is what `modified` and `conflict` compare against
	baseline: readonly RRS.RepeatRuleConfig[]
	draft: RRS.RepeatRuleConfig[]
	modified: boolean
	conflict: boolean
	saving: boolean
	// bumped whenever the draft is replaced wholesale, so uncontrolled inputs re-seed
	resetKey: number
}

export type Types = {
	name: 'repeatRulesetEditor'
	key: FRM.RawInstanceKey<object>
	input: Input
	state: Store
}

export type Key = FRM.InstanceKey<Types>
export type KeyProp = { repeatRulesetEditor: Key }
export type Frame = FRM.Frame<Types>

function repeatRulesetId$(source: Source): Rx.Observable<RRS.RulesetId | null> {
	switch (source.type) {
		case 'server':
			return Zus.toObservable(source.settingsKey, true).pipe(Rx.map(([s]) => s.settings.edited.queue.mainPool.repeatRulesetId))
		case 'pool-draft':
			return source.value$.pipe(Rx.map((pool) => pool?.repeatRulesetId ?? null))
		case 'rotation':
			return RotationClient.rotation$(source.rotationId).pipe(Rx.map((rotation) => rotation?.repeatRulesetId ?? null))
		default:
			assertNever(source)
	}
}

const NO_RULES: readonly RRS.RepeatRuleConfig[] = []

// copy-on-write. An undefined value removes an object key rather than holding undefined, so an unset option compares
// equal to the saved rule, where the key is absent.
function setAt(node: unknown, path: SETTINGS.SettingsPath, value: unknown): unknown {
	if (path.length === 0) return value
	const [head, ...rest] = path
	const copy: any = Array.isArray(node) ? [...node] : { ...(node as object) }
	const next = setAt((node as any)?.[head], rest, value)
	if (next === undefined && !Array.isArray(copy)) delete copy[head]
	else copy[head] = next
	return copy
}

function setup(args: FRM.SetupArgs<Input, Store>) {
	args.set({
		repeatRulesetId: null,
		saved: undefined,
		baseline: NO_RULES,
		draft: [],
		modified: false,
		conflict: false,
		saving: false,
		resetKey: 0,
	} satisfies Store)

	args.cleanup.push(
		Rx.combineLatest([
			repeatRulesetId$(args.input.source).pipe(Rx.distinctUntilChanged()),
			Zus.toStream(SettingsClient.PublicSettingsStore, SettingsClient.selectRepeatRulesets, { fireImmediately: true }),
		]).subscribe(([repeatRulesetId, rulesets]) => {
			const state = args.get()
			const saved = RRS.find(rulesets, repeatRulesetId)
			const savedRules = saved?.rules ?? NO_RULES
			if (repeatRulesetId !== state.repeatRulesetId || !state.modified) {
				if (repeatRulesetId === state.repeatRulesetId && Obj.deepEqual(savedRules, state.baseline) && saved === state.saved) return
				args.set({
					repeatRulesetId,
					saved,
					baseline: savedRules,
					draft: [...savedRules],
					modified: false,
					conflict: false,
					resetKey: state.resetKey + 1,
				})
				return
			}
			args.set({ saved, conflict: !Obj.deepEqual(savedRules, state.baseline) })
		}),
	)

	args.cleanup.push(
		args.update$.subscribe(([state, prev]) => {
			if (state.draft === prev.draft && state.baseline === prev.baseline) return
			const modified = !Obj.deepEqual(state.draft, state.baseline)
			if (modified !== state.modified) args.set({ modified })
		}),
	)
}

export const frame: Frame = frameManager.createFrame<Types>({
	name: 'repeatRulesetEditor',
	createKey: (frameId) => ({ frameId }),
	setup,
})

export namespace Sel {
	export function draft(state: Store) {
		return state.draft
	}
}

export namespace Actions {
	function store(stores: KeyProp) {
		return Zus.resolveStore<Store>(stores.repeatRulesetEditor)
	}

	// path is relative to the rules list
	export function set(stores: KeyProp, path: SETTINGS.SettingsPath, value: unknown) {
		store(stores).setState((state) => ({ draft: setAt(state.draft, path, value) as RRS.RepeatRuleConfig[] }))
	}

	// renames the ruleset being edited. Its saved rules go with the new name, so a draft in progress stays a draft.
	export async function rename(stores: KeyProp, name: string): Promise<boolean> {
		const { saved } = store(stores).getState()
		if (!saved) return false
		return await writeRepeatRuleset({ ...saved, name })
	}

	// creates a ruleset holding `rules`, resolving to its id, or null when it was not created
	export async function create(name: string, rules: readonly RRS.RepeatRuleConfig[]): Promise<RRS.RulesetId | null> {
		const rulesets = SettingsClient.selectRepeatRulesets(SettingsClient.PublicSettingsStore.getState())
		const id = RRS.freeId(rulesets, name)
		return (await writeRepeatRuleset({ id, name, rules: [...rules] })) ? id : null
	}

	async function writeRepeatRuleset(ruleset: RRS.Ruleset): Promise<boolean> {
		try {
			const res = await RPC.orpc.settings.global.saveRepeatRuleset.call(ruleset)
			switch (res.code) {
				case 'ok':
					return true
				case 'err:permission-denied':
					RbacClient.handlePermissionDenied(res)
					return false
				case 'err:invalid-settings':
					toast.error(...tr.toast(SETTINGS_Msgs.invalid(res.message)))
					return false
				default:
					assertNever(res)
			}
		} catch (err) {
			toast.error(...tr.toast(SETTINGS_Msgs.saveFailed(err instanceof Error ? err.message : String(err))))
			return false
		}
	}

	export function reset(stores: KeyProp) {
		store(stores).setState((state) => ({ draft: [...state.baseline], conflict: false, resetKey: state.resetKey + 1 }))
	}

	// saves the draft as the ruleset's rules. Resolves to whether there is nothing left unsaved, so a host saving
	// alongside its own changes can tell whether to go on.
	export async function save(stores: KeyProp): Promise<boolean> {
		const s = store(stores)
		const { saved, draft, modified } = s.getState()
		if (!modified) return true
		if (!saved) return false
		s.setState({ saving: true })
		try {
			if (!(await writeRepeatRuleset({ ...saved, rules: draft }))) return false
			// the published rulesets catch up on their own; until then the draft is what was saved
			s.setState({ baseline: draft, conflict: false })
			return true
		} finally {
			s.setState({ saving: false })
		}
	}
}
