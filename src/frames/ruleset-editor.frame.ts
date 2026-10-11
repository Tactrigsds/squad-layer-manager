import type * as ServerSettingsPrt from '@/frame-partials/server-settings.partial'
import type * as FRM from '@/lib/frame'
import * as Obj from '@/lib/object-utils'
import * as Rx from '@/lib/rxjs'
import { toast } from '@/lib/toast'
import { assertNever } from '@/lib/type-guards'
import * as Zus from '@/lib/zustand'
import * as SETTINGS_Msgs from '@/messages/settings.messages'
import * as RS from '@/models/rulesets.models'
import type * as SETTINGS from '@/models/settings.models'
import * as RPC from '@/orpc.client'
import { tr } from '@/systems/messages.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SettingsClient from '@/systems/settings.client'

import { frameManager } from './frame-manager'

// A draft of the rules of one ruleset, for the editors that sit beside whatever chooses the ruleset: the pool
// configuration window and the settings page's server form. The ruleset follows that chooser's (unsaved) choice, so
// picking another ruleset there swaps the rules being edited here.
//
// The draft re-seeds from the saved ruleset whenever the choice changes, and when someone else saves the ruleset
// while the draft holds no edits. A draft with edits is kept, and flagged as conflicting, so saving it is a choice to
// overwrite theirs.

export type Source =
	// the rulesetId in the edited (unsaved) settings of a server
	| { type: 'server'; settingsKey: ServerSettingsPrt.Key }
	// the rulesetId in a pool configuration draft (queue.mainPool), as the settings page's form holds it
	| { type: 'pool-draft'; value$: Rx.Observable<{ rulesetId?: RS.RulesetId | null } | undefined> }

export type Input = { source: Source }

export type Store = {
	rulesetId: RS.RulesetId | null
	// the ruleset as last saved; undefined when the id resolves to nothing
	saved: RS.Ruleset | undefined
	// the saved rules the draft started from, which is what `modified` and `conflict` compare against
	baseline: readonly RS.RepeatRuleConfig[]
	draft: RS.RepeatRuleConfig[]
	modified: boolean
	conflict: boolean
	saving: boolean
	// bumped whenever the draft is replaced wholesale, so uncontrolled inputs re-seed
	resetKey: number
}

export type Types = {
	name: 'rulesetEditor'
	key: FRM.RawInstanceKey<object>
	input: Input
	state: Store
}

export type Key = FRM.InstanceKey<Types>
export type KeyProp = { rulesetEditor: Key }
export type Frame = FRM.Frame<Types>

function rulesetId$(source: Source): Rx.Observable<RS.RulesetId | null> {
	switch (source.type) {
		case 'server':
			return Zus.toObservable(source.settingsKey, true).pipe(Rx.map(([s]) => s.settings.edited.queue.mainPool.rulesetId))
		case 'pool-draft':
			return source.value$.pipe(Rx.map((pool) => pool?.rulesetId ?? null))
		default:
			assertNever(source)
	}
}

const NO_RULES: readonly RS.RepeatRuleConfig[] = []

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
		rulesetId: null,
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
			rulesetId$(args.input.source).pipe(Rx.distinctUntilChanged()),
			Zus.toStream(SettingsClient.PublicSettingsStore, SettingsClient.selectRulesets, { fireImmediately: true }),
		]).subscribe(([rulesetId, rulesets]) => {
			const state = args.get()
			const saved = RS.find(rulesets, rulesetId)
			const savedRules = saved?.rules ?? NO_RULES
			if (rulesetId !== state.rulesetId || !state.modified) {
				if (rulesetId === state.rulesetId && Obj.deepEqual(savedRules, state.baseline) && saved === state.saved) return
				args.set({
					rulesetId,
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
	name: 'rulesetEditor',
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
		return Zus.resolveStore<Store>(stores.rulesetEditor)
	}

	// path is relative to the rules list
	export function set(stores: KeyProp, path: SETTINGS.SettingsPath, value: unknown) {
		store(stores).setState((state) => ({ draft: setAt(state.draft, path, value) as RS.RepeatRuleConfig[] }))
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
			const res = await RPC.orpc.settings.global.saveRuleset.call({ ...saved, rules: draft })
			switch (res.code) {
				case 'ok':
					// the published rulesets catch up on their own; until then the draft is what was saved
					s.setState({ baseline: draft, conflict: false })
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
		} finally {
			s.setState({ saving: false })
		}
	}
}
