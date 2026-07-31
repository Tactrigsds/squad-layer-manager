import { assertNever } from '@/lib/type-guards'
import * as F from '@/models/filter.models'
import * as SETTINGS from '@/models/settings.models'

// Where a filter entity is used, so that deleting one can be refused while anything still points at it and the
// filter's own pages can say what is pointing at it.
//
// The extra filters a user pulls into the applied-filters panel are deliberately not references: they are a
// per-browser view preference, so a deleted filter is dropped from them rather than blocking the delete (see
// frame-partials/applied-filters.partial.ts).

// every mainPool key that names filter entities. poolFilter decides pool membership; the rest add behavior on
// top of it.
export const POOL_CONFIG_KEYS = ['poolFilter', ...SETTINGS.SECONDARY_LIST_KEYS] as const
export type PoolConfigKey = (typeof POOL_CONFIG_KEYS)[number]

export type Reference =
	// the tree of `filterId` applies the referenced filter through an apply-filter operator
	| { type: 'filter-entity'; filterId: F.FilterEntityId }
	// a server's pool configuration reaches the referenced filter. `via` is the chain of apply-filter hops from
	// the configured filter down to it, empty when the pool names it directly.
	| { type: 'pool-config'; serverId: string; key: PoolConfigKey; via: F.FilterEntityId[] }

// filter id -> everything referencing it. A filter with no entry is referenced by nothing.
export type Index = Map<F.FilterEntityId, Reference[]>

export type ServerPoolConfig = { serverId: string; mainPool: SETTINGS.PoolConfiguration }

// The filter ids one pool config key names. The switch is what makes this systematic: a new mainPool list of
// filters fails to typecheck here until it is either counted as a reference or excluded from POOL_CONFIG_KEYS.
export function poolConfigFilterIds(pool: SETTINGS.PoolConfiguration, key: PoolConfigKey): F.FilterEntityId[] {
	switch (key) {
		case 'poolFilter':
			return pool.poolFilter ? [pool.poolFilter.filterId] : []
		case 'indicateMatches':
			return [...pool.indicateMatches]
		case 'indicateMisses':
			return [...pool.indicateMisses]
		case 'defaultSelectable':
			return pool.defaultSelectable.map((c) => c.filterId)
		case 'warnFor':
			return pool.warnFor.map((c) => c.filterId)
		case 'constrainGeneration':
			return pool.constrainGeneration.map((c) => c.filterId)
		default:
			assertNever(key)
	}
}

type FilterGraph = ReadonlyMap<F.FilterEntityId, ReadonlySet<F.FilterEntityId>>

export function buildGraph(filters: Iterable<F.FilterEntity>): FilterGraph {
	const graph = new Map<F.FilterEntityId, ReadonlySet<F.FilterEntityId>>()
	for (const entity of filters) {
		graph.set(entity.id, F.appliedFilterIds(entity.filter))
	}
	return graph
}

export function buildIndex(filters: Iterable<F.FilterEntity>, servers: Iterable<ServerPoolConfig>): Index {
	const graph = buildGraph(filters)
	const index: Index = new Map()
	const add = (filterId: F.FilterEntityId, reference: Reference) => {
		const references = index.get(filterId)
		if (references) references.push(reference)
		else index.set(filterId, [reference])
	}

	for (const [filterId, applied] of graph) {
		for (const appliedId of applied) {
			add(appliedId, { type: 'filter-entity', filterId })
		}
	}

	for (const { serverId, mainPool } of servers) {
		for (const key of POOL_CONFIG_KEYS) {
			for (const configuredId of poolConfigFilterIds(mainPool, key)) {
				// breadth-first from the configured filter so each reachable filter records the shortest chain of
				// hops that got there. `seen` also stops a cycle among the filters from looping forever.
				const seen = new Set<F.FilterEntityId>([configuredId])
				let frontier: { id: F.FilterEntityId; via: F.FilterEntityId[] }[] = [{ id: configuredId, via: [] }]
				while (frontier.length > 0) {
					const next: typeof frontier = []
					for (const { id, via } of frontier) {
						add(id, { type: 'pool-config', serverId, key, via })
						for (const appliedId of graph.get(id) ?? []) {
							if (seen.has(appliedId)) continue
							seen.add(appliedId)
							next.push({ id: appliedId, via: [...via, id] })
						}
					}
					frontier = next
				}
			}
		}
	}

	return index
}

export function referencesFor(index: Index, filterId: F.FilterEntityId): Reference[] {
	return index.get(filterId) ?? []
}

// This filter is what decides a server's pool membership. Being reached through the pool filter is not the same
// thing, so a reference with hops behind it does not qualify.
export function isPoolFilterReference(reference: Reference): boolean {
	return reference.type === 'pool-config' && reference.key === 'poolFilter' && reference.via.length === 0
}

export function poolFilterServerIds(references: Reference[]): string[] {
	const ids: string[] = []
	for (const reference of references) {
		if (reference.type === 'pool-config' && isPoolFilterReference(reference)) ids.push(reference.serverId)
	}
	return ids
}

// The apply-filter chain leading from `startId` back to a filter already on the path, or null if there is none.
// The returned path starts at the first filter in the cycle and ends with that same filter repeated, so it reads
// as the loop it describes.
export function findCycle(filters: Iterable<F.FilterEntity>, startId: F.FilterEntityId): F.FilterEntityId[] | null {
	const graph = buildGraph(filters)
	const path: F.FilterEntityId[] = []
	const onPath = new Set<F.FilterEntityId>()
	const exhausted = new Set<F.FilterEntityId>()

	function visit(id: F.FilterEntityId): F.FilterEntityId[] | null {
		if (onPath.has(id)) return [...path.slice(path.indexOf(id)), id]
		if (exhausted.has(id)) return null
		path.push(id)
		onPath.add(id)
		for (const appliedId of graph.get(id) ?? []) {
			const cycle = visit(appliedId)
			if (cycle) return cycle
		}
		path.pop()
		onPath.delete(id)
		exhausted.add(id)
		return null
	}

	return visit(startId)
}
