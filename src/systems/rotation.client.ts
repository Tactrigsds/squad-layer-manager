// Rotations as the client holds them: pages of summaries fetched on demand, a rotation in full while something
// watches it, and the names of the rotations that queue items point at. rotations.watchChanges invalidates whatever a
// change touches.
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'

import * as ReactRx from '@/lib/react-rxjs'
import * as Rx from '@/lib/rxjs'
import { toast } from '@/lib/toast'
import { assertNever } from '@/lib/type-guards'
import * as Zus from '@/lib/zustand'
import * as F_Msgs from '@/messages/filter.messages'
import * as ROT_Msgs from '@/messages/rotations.messages'
import type * as AppEvents from '@/models/app-events.models'
import * as LTag from '@/models/layer-tags.models'
import * as ROT from '@/models/rotations.models'
import type * as USR from '@/models/users.models'
import * as RPC from '@/orpc.client'
import * as AppEventsClient from '@/systems/app-events.client'
import { tr } from '@/systems/messages.client'
import * as PartsSys from '@/systems/parts.client'
import * as RbacClient from '@/systems/rbac.client'
import type { RotationChange } from '@/systems/rotation.server'
import * as SettingsClient from '@/systems/settings.client'

const MAX_NAME_LOOKUPS = 200

export type State = {
	// the names this client has fetched; null for a rotation that does not exist
	names: ReadonlyMap<ROT.RotationId, string | null>
}

export const Store = Zus.createStore<State>(() => ({ names: new Map() }))

export namespace Sel {
	export function names(state: State) {
		return state.names
	}
}

// -------- names --------

const pendingNames = new Set<ROT.RotationId>()
const fetchingNames = new Set<ROT.RotationId>()
let namesFlushScheduled = false

// fetches the names of whichever of `ids` are not known yet, batched with every other request in the same tick
export function requestNames(ids: Iterable<ROT.RotationId>) {
	const { names } = Store.getState()
	for (const id of ids) {
		if (!names.has(id) && !fetchingNames.has(id)) pendingNames.add(id)
	}
	if (pendingNames.size === 0 || namesFlushScheduled) return
	namesFlushScheduled = true
	queueMicrotask(() => void flushNames())
}

async function flushNames() {
	namesFlushScheduled = false
	const ids = [...pendingNames]
	pendingNames.clear()
	for (const id of ids) fetchingNames.add(id)
	const batches: ROT.RotationId[][] = []
	for (let i = 0; i < ids.length; i += MAX_NAME_LOOKUPS) batches.push(ids.slice(i, i + MAX_NAME_LOOKUPS))
	await Promise.all(
		batches.map(async (batch) => {
			try {
				const found = await RPC.orpc.rotations.getNames.call(batch)
				Store.setState((state) => {
					const names = new Map(state.names)
					for (const id of batch) names.set(id, found[id] ?? null)
					return { names }
				})
			} catch (error) {
				// left unknown, so the next render that needs one asks again
				console.error('failed to fetch rotation names', error)
			} finally {
				for (const id of batch) fetchingNames.delete(id)
			}
		}),
	)
}

// the rotation's name; undefined until fetched, null when the rotation does not exist
export function useName(rotationId: ROT.RotationId): string | null | undefined {
	const name = Zus.useStore(Store, (s) => s.names.get(rotationId))
	if (name === undefined) requestNames([rotationId])
	return name
}

// the names of the rotations that `tags` mark items as coming from, fetched as needed
export function useTagRotationNames(tags: readonly LTag.TagId[] | undefined) {
	const names = Zus.useStore(Store, Sel.names)
	const missing = (tags ?? []).flatMap((tag) => {
		const rotationId = LTag.rotationIdOfTag(tag)
		return rotationId !== undefined && !names.has(rotationId) ? [rotationId] : []
	})
	if (missing.length > 0) requestNames(missing)
	return names
}

// -------- queries --------

export function searchQuery(search: ROT.IndexSearch) {
	const input = ROT.compactIndexSearch(search)
	return infiniteQueryOptions({
		queryKey: [...RPC.orpc.rotations.search.key(), input],
		queryFn: async ({ pageParam }) => PartsSys.stripParts(await RPC.orpc.rotations.search.call({ ...input, cursor: pageParam })),
		initialPageParam: undefined as ROT.SearchCursor | undefined,
		getNextPageParam: (page) => page.nextCursor ?? undefined,
	})
}

export function facetsQuery() {
	return queryOptions({
		queryKey: RPC.orpc.rotations.getFacets.key(),
		queryFn: async () => PartsSys.stripParts(await RPC.orpc.rotations.getFacets.call()),
	})
}

export function getQuery(rotationId: ROT.RotationId) {
	return queryOptions({
		queryKey: [...RPC.orpc.rotations.get.key(), rotationId],
		queryFn: async () => PartsSys.stripParts(await RPC.orpc.rotations.get.call(rotationId)).rotation,
	})
}

export function suggestCloneIdQuery(sourceId: ROT.RotationId) {
	return RPC.orpc.rotations.suggestCloneId.queryOptions({ input: sourceId, staleTime: 0 })
}

export function getContributorsQuery(rotationId: ROT.RotationId) {
	return RPC.orpc.rotations.getContributors.queryOptions({ input: rotationId })
}

// -------- one rotation, live --------

// the rotation in full, kept current while anything watches it: undefined until it arrives, null when it does not exist
export const [useRotation, rotation$] = ReactRx.bindWithDefault(
	(rotationId: ROT.RotationId) =>
		RPC.observe(`rotations.watchRotation:${rotationId}`, () => RPC.orpc.rotations.watchRotation.call({ rotationId })).pipe(
			Rx.map((output) => PartsSys.stripParts(output).rotation),
		),
	undefined as ROT.Rotation | null | undefined,
)

// -------- actions --------

type MutationResult = { code: string; message?: string; msg?: string }

// reports a failed call; true when the call succeeded
function handleResult(res: MutationResult): boolean {
	if (res.code === 'ok') return true
	if (res.code === 'err:permission-denied') RbacClient.handlePermissionDenied(res as never)
	else if (res.code === 'err:already-exists') toast.error(...tr.toast(ROT_Msgs.idTaken()))
	else toast.error(...tr.toast(ROT_Msgs.actionFailed(res.message ?? res.msg ?? res.code)))
	return false
}

export namespace Actions {
	export async function create(input: ROT.NewRotation): Promise<boolean> {
		return handleResult(await RPC.orpc.rotations.create.call(input))
	}

	export async function clone(input: ROT.CloneInput) {
		return handleResult(await RPC.orpc.rotations.clone.call(input))
	}

	export async function updateMeta(rotationId: ROT.RotationId, patch: ROT.MetaPatch): Promise<boolean> {
		return handleResult(await RPC.orpc.rotations.updateMeta.call({ rotationId, patch }))
	}

	export async function setTag(rotation: Pick<ROT.Meta, 'id' | 'tags'>, tagId: LTag.TagId, applied: boolean): Promise<boolean> {
		const tags = applied ? [...new Set([...rotation.tags, tagId])] : rotation.tags.filter((id) => id !== tagId)
		return await updateMeta(rotation.id, { tags })
	}

	export async function addContributor(rotationId: ROT.RotationId, who: { userId: USR.UserId } | { roleId: string }) {
		const res = await RPC.orpc.rotations.addContributor.call({ rotationId, ...who })
		if (res.code === 'err:already-exists') toast(...tr.toast(F_Msgs.contributorAlreadyAdded()))
		else handleResult(res)
		void RPC.queryClient.invalidateQueries({ queryKey: getContributorsQuery(rotationId).queryKey })
	}

	export async function removeContributor(rotationId: ROT.RotationId, who: { userId: USR.UserId } | { roleId: string }) {
		const res = await RPC.orpc.rotations.removeContributor.call({ rotationId, ...who })
		if (res.code === 'err:not-found') toast(...tr.toast(F_Msgs.contributorNotFound()))
		else handleResult(res)
		void RPC.queryClient.invalidateQueries({ queryKey: getContributorsQuery(rotationId).queryKey })
	}

	// creates a layer tag for each label, resolving to each label's new id, lowercased, or null when one failed
	export async function createLayerTags(labels: string[]): Promise<Map<string, LTag.TagId> | null> {
		const created = new Map<string, LTag.TagId>()
		const taken = [...(SettingsClient.PublicSettingsStore.getState()?.layerTags ?? [])]
		for (const label of labels) {
			const tag: LTag.Tag = { id: LTag.createTagId(label), label, description: '', color: LTag.suggestColor(taken) }
			const res = await RPC.orpc.settings.global.upsertLayerTag.call(tag)
			if (res.code !== 'ok') {
				if (res.code === 'err:permission-denied') RbacClient.handlePermissionDenied(res)
				else toast.error(...tr.toast(ROT_Msgs.actionFailed(res.message)))
				return null
			}
			taken.push(res.tag)
			created.set(label.toLowerCase(), res.tag.id)
		}
		return created
	}

	export async function remove(rotation: Pick<ROT.Meta, 'id' | 'name'>): Promise<boolean> {
		deletingHere.add(rotation.id)
		const ok = handleResult(await RPC.orpc.rotations.delete.call(rotation.id))
		if (ok) toast(...tr.toast(ROT_Msgs.deleted(rotation.name)))
		else deletingHere.delete(rotation.id)
		return ok
	}
}

// rotations this tab is deleting, which report their own deletion
const deletingHere = new Set<ROT.RotationId>()

function reportDeletion(mutation: ROT.SummaryMutation & { actor: AppEvents.Actor }) {
	if (deletingHere.delete(mutation.key)) return
	void AppEventsClient.reportDeletion({
		item: { index: '/rotations', to: '/rotations/$rotationId', params: { rotationId: mutation.key } },
		actor: mutation.actor,
		describe: (actorName) => tr.toast(ROT_Msgs.deletedBy(mutation.value.name, actorName)),
	})
}

// -------- keeping caches current --------

function invalidateLists() {
	void RPC.queryClient.invalidateQueries({ queryKey: RPC.orpc.rotations.search.key() })
	void RPC.queryClient.invalidateQueries({ queryKey: RPC.orpc.rotations.getFacets.key() })
}

function applyChange(change: RotationChange) {
	switch (change.code) {
		case 'subscribed':
			// changes made while this client was away went unseen, so everything fetched before is suspect
			Store.setState({ names: new Map() })
			void RPC.queryClient.invalidateQueries({ queryKey: RPC.orpc.rotations.key() })
			break
		case 'mutation': {
			const { mutation } = change
			const { names } = Store.getState()
			const name = mutation.type === 'delete' ? null : mutation.value.name
			if (names.has(mutation.key) && names.get(mutation.key) !== name) {
				Store.setState({ names: new Map(names).set(mutation.key, name) })
			}
			void RPC.queryClient.invalidateQueries({ queryKey: [...RPC.orpc.rotations.get.key(), mutation.key] })
			if (mutation.type === 'delete') reportDeletion(mutation)
			break
		}
		default:
			assertNever(change)
	}
}

export function setup() {
	const change$ = RPC.observe('rotations.watchChanges', () => RPC.orpc.rotations.watchChanges.call()).pipe(
		Rx.map((output) => PartsSys.stripParts(output) as RotationChange),
		Rx.share(),
	)
	change$.subscribe(applyChange)
	// a burst of changes, as a plugin can make, refetches the lists once
	change$
		.pipe(
			Rx.filter((change) => change.code === 'mutation'),
			Rx.auditTime(250),
		)
		.subscribe(invalidateLists)
}
