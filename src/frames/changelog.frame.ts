import type * as FRM from '@/lib/frame'
import * as RSel from '@/lib/reselect'
import * as Zus from '@/lib/zustand'
import * as CL from '@/models/changelog.models'
import * as RPC from '@/orpc.client'
import * as ChangelogClient from '@/systems/changelog.client'

import { frameManager } from './frame-manager'

// One visit to the What's new page. It fetches the changelog once, keeps the caller's `seenAt` from before the visit
// so the New markers stay put for as long as the page is open, then marks everything it showed as seen.

export type Key = FRM.InstanceKey<Types>
export type KeyProp = FRM.KeyProp<Types>
export type Frame = FRM.Frame<Types>
export type Input = Record<never, never>
export type Types = {
	name: 'changelog'
	key: FRM.RawInstanceKey<Input>
	input: Input
	state: Store
}

export type Data = { version: string; releases: CL.ServedRelease[]; seenAt: number }

export type Store = {
	data: Data | null
	failed: boolean
	query: string
	// null until the changelog loads
	prefs: CL.Prefs | null
}

export const frame: Frame = frameManager.createFrame<Types>({
	name: 'changelog',
	createKey: (frameId) => ({ frameId }),
	setup(args) {
		args.set({ data: null, failed: false, query: '', prefs: null } satisfies Store)
		void load(args).catch((err) => {
			console.error('failed to load the changelog', err)
			if (!args.signal.aborted) args.set({ failed: true })
		})
	},
})

async function load(args: FRM.SetupArgs<Input, Store>) {
	const res = await RPC.queryClient.fetchQuery({ ...ChangelogClient.changelogQueryOptions, staleTime: 0 })
	if (args.signal.aborted) return
	args.set({
		data: { version: res.version, releases: res.releases, seenAt: res.seenAt },
		prefs: { notifyLevel: res.notifyLevel, showOperatorNotes: res.showOperatorNotes },
	})
	const upTo = CL.latestServedAt(res.releases)
	if (upTo > res.seenAt) await ChangelogClient.Actions.markSeen(upTo)
}

export type VisibleEntry = CL.ServedEntry & { unseen: boolean }
export type VisibleRelease = {
	version: string | null
	date: string | null
	headline: { users: VisibleEntry[]; operators: VisibleEntry[] }
	minor: { users: VisibleEntry[]; operators: VisibleEntry[] }
	unseenCount: number
}

function entryMatches(entry: CL.Entry, needle: string) {
	return entry.title.toLowerCase().includes(needle) || (entry.body?.toLowerCase().includes(needle) ?? false)
}

export namespace Sel {
	// the releases as the page lays them out: filtered by the search and the operator notes preference, split into
	// headline and minor entries per audience, with releases that have nothing left dropped
	export const visibleReleases = RSel.createSelector(
		[(s: Store) => s.data, (s: Store) => s.query, (s: Store) => s.prefs?.showOperatorNotes ?? false],
		(data, query, showOps): VisibleRelease[] => {
			if (!data) return []
			const needle = query.trim().toLowerCase()
			const out: VisibleRelease[] = []
			for (const release of data.releases) {
				const visible: VisibleRelease = {
					version: release.version,
					date: release.date,
					headline: { users: [], operators: [] },
					minor: { users: [], operators: [] },
					unseenCount: 0,
				}
				let any = false
				for (const entry of release.entries) {
					if (entry.audience === 'operators' && !showOps) continue
					if (needle && !entryMatches(entry, needle)) continue
					const unseen = entry.firstServedAt > data.seenAt
					if (unseen && !entry.minor) visible.unseenCount++
					;(entry.minor ? visible.minor : visible.headline)[entry.audience].push({ ...entry, unseen })
					any = true
				}
				if (any) out.push(visible)
			}
			return out
		},
	)

	export function pendingCount(state: Store): number {
		const first = state.data?.releases[0]
		return first && first.version === null ? first.entries.length : 0
	}

	export function latestVersion(state: Store): string | null {
		return state.data?.releases.find((r) => r.version !== null)?.version ?? null
	}
}

export namespace Actions {
	function store(stores: KeyProp) {
		return Zus.resolveStore<Store>(stores.changelog)
	}

	export function setQuery(stores: KeyProp, query: string) {
		store(stores).setState({ query })
	}

	export async function setPrefs(stores: KeyProp, patch: Partial<CL.Prefs>) {
		const prefs = store(stores).getState().prefs
		if (!prefs) return
		store(stores).setState({ prefs: { ...prefs, ...patch } })
		await ChangelogClient.Actions.setPrefs(patch)
	}
}
