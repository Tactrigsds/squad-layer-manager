// What a frame holding an editable layer list provides to the list editor, the layer pickers and the statuses they
// show. The squad server frame is one such host (the server's queue), the rotation editor frame another (a rotation's
// items). Everything here is the same for both; what differs is where the list, the settings and the history come from.
import * as LayerQueuePrt from '@/frame-partials/layer-queue.partial'
import type * as FRM from '@/lib/frame'
import { createId } from '@/lib/id'
import * as Rx from '@/lib/rxjs'
import { toast } from '@/lib/toast'
import { assertNever } from '@/lib/type-guards'
import * as Zus from '@/lib/zustand'
import * as LL_Msgs from '@/messages/layer-list.messages'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import type * as RRS from '@/models/repeat-rulesets.models'
import * as SETTINGS from '@/models/settings.models'
import * as LayerQueriesClient from '@/systems/layer-queries.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import { tr } from '@/systems/messages.client'
import * as SettingsClient from '@/systems/settings.client'
import * as UPClient from '@/systems/user-presence.client'

export type Store = LayerQueuePrt.Store & {
	listHost: LL.ListHost
	// the list with the match history before it, which is what repeat rules are measured against
	layerItemsState: LQY.LayerItemsState
	layerItemStatuses: LQY.LayerItemStatuses | null
	// the list the statuses above were computed for. Statuses lag an edit by a debounce plus a query, so a caller that
	// has to be right about them (the save flow gates on warnings) can tell current answers from stale ones. Display
	// keeps using the stale ones meanwhile, which is what stops the indicators flickering on every edit.
	layerItemStatusesFor: LQY.LayerItemsState | null
	// the rules of the host's ruleset
	repeatRules: RRS.RepeatRuleConfig[]
	// a server's saved settings; a rotation has no server, and stands in the catalog's (SETTINGS.catalogSettings)
	settings: { saved: SETTINGS.PublicServerSettings }
	// what the last saved list warns about on its own. The save flow subtracts these from the draft's warnings to
	// find the ones the current edit session is answerable for. Refreshed on demand at save time rather than watched:
	// a second standing status query starves the one the indicators read (see refreshSavedQueueWarnings).
	savedQueueWarnings: LQY.QueueWarning[] | null
	// a Fix Repeats run is searching or applying its edits
	fixingRepeats: boolean
}
export type Key = FRM.InstanceKeyOfState<Store>
export type KeyProp = { listHost: Key }

export const INITIAL: Pick<
	Store,
	'layerItemsState' | 'layerItemStatuses' | 'layerItemStatusesFor' | 'repeatRules' | 'savedQueueWarnings' | 'fixingRepeats'
> = {
	layerItemsState: LQY.initLayerItemsState(),
	layerItemStatuses: null,
	layerItemStatusesFor: null,
	repeatRules: [],
	savedQueueWarnings: null,
	fixingRepeats: false,
}

// keeps layerItemStatuses current with the list, the settings, the rules and the filters they are computed from
export function initStatuses(args: FRM.SetupArgs<object, Store, Store>) {
	const state$ = Zus.toObservable(args.key, true)
	args.cleanup.push(
		Rx.combineLatest([
			state$.pipe(
				Rx.map(([state]) => state.layerItemsState),
				Rx.distinctUntilChanged(),
			),
			state$.pipe(
				Rx.map(([state]) => state.settings.saved),
				Rx.distinctUntilChanged(),
			),
			// filter edits invalidate previously computed statuses
			Zus.toObservable(LayerQueriesClient.Store, true).pipe(
				Rx.map(([state]) => state.backgroundStateEpoch),
				Rx.distinctUntilChanged(),
			),
			state$.pipe(
				Rx.map(([state]) => state.repeatRules),
				Rx.distinctUntilChanged(),
			),
		])
			.pipe(
				Rx.debounceTime(250),
				Rx.switchMap(([list, settings, _epoch, repeatRules]) =>
					LayerQueriesClient.layerItemStatuses$({
						constraints: SETTINGS.getSettingsConstraints(settings, repeatRules),
						skipWarningsForTags: settings.queue.mainPool.skipWarningsForTags,
						list,
					}).pipe(
						Rx.map((layerItemStatuses) => [layerItemStatuses, list] as const),
						Rx.catchError(() => Rx.EMPTY),
					),
				),
			)
			.subscribe(([layerItemStatuses, list]) => {
				if (layerItemStatuses) args.set({ layerItemStatuses, layerItemStatusesFor: list })
			}),
	)
}

const NO_RULES: RRS.RepeatRuleConfig[] = []

export namespace Sel {
	export function host(state: Store) {
		return state.listHost
	}
	export function settings(state: Store) {
		return state.settings.saved
	}
	// with no list host the fallback is the catalog rather than the schema defaults: a dialog opened outside one
	// describes every layer that exists, not the ones a hypothetical vanilla server could load
	export function settingsOrDefault(state: Store | undefined) {
		return state?.settings.saved ?? SETTINGS.catalogSettings()
	}
	// with no list host, no repeat rules apply
	export function repeatRulesOrNone(state: Store | undefined) {
		return state?.repeatRules ?? NO_RULES
	}
	// the team parity and queue offset the first of a batch of items takes when added at the start or the end of the
	// list, so a preview can show those items the way the list will
	export const insertionPoint = (position: 'start' | 'end') => (state: Store) => {
		const { layerItems, firstLayerItemParity } = state.layerItemsState
		const list = LayerQueuePrt.Sel.layerList(state)
		const anchor = position === 'start' ? list[0] : undefined
		const anchorIndex = anchor ? layerItems.findIndex((item) => item.itemId === anchor.itemId) : -1
		const layerItemIndex = anchorIndex === -1 ? layerItems.length : anchorIndex
		return { parity: firstLayerItemParity + layerItemIndex, queueOffset: position === 'start' ? 0 : list.length }
	}
	export function serverId(state: Store): string | undefined {
		return state.listHost.type === 'server' ? state.listHost.serverId : undefined
	}
}

export function statusesAreCurrent(state: Store) {
	return state.layerItemStatusesFor === state.layerItemsState
}

// Statuses lag the list by a debounce plus a query, so reading them straight after an edit gates the save on warnings
// computed for a list the user has already edited away from -- which is how a stale warning could both block a save
// and then vanish, leaving the editor stuck. Wait for the statuses that belong to the list as it is now.
export async function awaitCurrentStatuses(key: Zus.AnyStore<Store>, timeoutMs = 5000): Promise<void> {
	if (statusesAreCurrent(Zus.getState(key))) return
	await Rx.firstValueFrom(
		Zus.toObservable(key, true).pipe(
			Rx.filter(([state]) => statusesAreCurrent(state)),
			// a query that never lands must not strand the editor: fall through and gate on what we have
			Rx.timeout({ first: timeoutMs, with: () => Rx.of(null) }),
		),
	)
}

async function recentMatchesFor(host: LL.ListHost) {
	switch (host.type) {
		case 'server':
			return await Rx.firstValueFrom(MatchHistoryClient.recentMatches$(host.serverId))
		case 'rotation':
			return []
		default:
			assertNever(host)
	}
}

// The baseline the save flow subtracts: what the saved list warns about with nobody's edits applied. Run on demand
// rather than watched alongside the draft's statuses -- both queries go to the same worker, and a second standing one
// starves the draft query the indicators read.
export async function refreshSavedQueueWarnings(key: Zus.AnyStore<Store>): Promise<void> {
	const store = Zus.resolveStore<Store>(key)
	const state = store.getState()
	const settings = state.settings.saved
	const recentMatches = await recentMatchesFor(state.listHost)
	const savedList = LQY.resolveLayerItemsState(state.queue.rbSession.localState.savedList, recentMatches)
	const statuses = await LayerQueriesClient.fetchLayerItemStatuses({
		constraints: SETTINGS.getSettingsConstraints(settings, state.repeatRules),
		skipWarningsForTags: settings.queue.mainPool.skipWarningsForTags,
		list: savedList,
	})
	// a failed query leaves the baseline null, which reports every warning rather than dropping one on a guess
	store.setState({ savedQueueWarnings: statuses?.warns ?? null })
}

export namespace Actions {
	// Rearranges the draft list to clear repeat warnings. There is no batch op, so the edits go out one at a time and
	// stop at the first one the server refuses.
	export async function fixRepeats(stores: KeyProp) {
		const s = Zus.resolveStore<Store>(stores.listHost)
		if (s.getState().fixingRepeats) return
		s.setState({ fixingRepeats: true })
		try {
			const state = s.getState()
			const settings = state.settings.saved
			const list = state.layerItemsState
			const layerTags = SettingsClient.PublicSettingsStore.getState()?.layerTags ?? []
			const presence = UPClient.Store.getState()
			const res = await LayerQueriesClient.solveRepeatViolations({
				list,
				constraints: SETTINGS.getSettingsConstraints(settings, state.repeatRules),
				skipWarningsForTags: settings.queue.mainPool.skipWarningsForTags,
				noSwapTags: layerTags.filter((tag) => tag.preventSwaps).map((tag) => tag.id),
				poolConstraints: SETTINGS.getPoolMembershipConstraints(settings),
				// another editor is working on these
				pinnedItemIds: state.queue.layerList
					.map((item) => item.itemId)
					.filter((itemId) => UPClient.Sel.isSllItemLocked(itemId)(presence)),
			})
			if (res?.code !== 'ok') {
				toast.error(...tr.toast(LL_Msgs.fixRepeatsFailed()))
				return
			}
			if (res.baselineViolations === 0) {
				toast(...tr.toast(LL_Msgs.noRepeatsToFix()))
				return
			}
			if (res.violations === res.baselineViolations) {
				toast(...tr.toast(LL_Msgs.repeatsUnfixable()))
				return
			}
			if (s.getState().layerItemsState !== list) {
				toast.error(...tr.toast(LL_Msgs.queueChangedDuringFix()))
				return
			}

			const queue = { queue: stores.listHost }
			const undo: LayerQueuePrt.Actions.DispatchOpts = { undoGroup: `fix-repeats:${createId(8)}` }
			const current = s.getState().queue.layerList.map((item) => item.itemId)
			const moves = LL.movesToOrder(current, res.order as LL.ItemId[])
			for (const itemId of res.swapped) {
				if (!(await LayerQueuePrt.Actions.dispatch(queue, { op: 'swap-factions', itemId: itemId as LL.ItemId }, undo))) return
			}
			for (const move of moves) {
				const op = { op: 'move' as const, itemId: move.itemId, cursor: move.cursor, newFirstItemId: LL.createItemId() }
				if (!(await LayerQueuePrt.Actions.dispatch(queue, op, undo))) return
			}
			const affected = new Set([...res.swapped, ...moves.map((move) => move.itemId)])
			toast.success(
				...tr.toast(LL_Msgs.repeatsFixed(res.baselineViolations, res.violations, res.swapped.length + moves.length, affected.size)),
			)
		} finally {
			s.setState({ fixingRepeats: false })
		}
	}
}
