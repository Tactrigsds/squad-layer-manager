// The filters page's search, kept in its url: a text search over names and descriptions, an owner, and an order
import { assertNever } from '@/lib/type-guards'
import { z } from '@/lib/zod'
import * as F from '@/models/filter.models'

// `default` puts pool filters first, then filters with an emoji, then the rest, each by name
export const INDEX_SORT = z.enum(['default', 'name'])
export type IndexSort = z.infer<typeof INDEX_SORT>

// `author` is an owner key (see F.ownerKey)
export const IndexSearchSchema = z.object({
	q: z.string().optional(),
	author: z.string().optional(),
	sort: INDEX_SORT.optional(),
	dir: z.enum(['asc', 'desc']).optional(),
})
export type IndexSearch = z.infer<typeof IndexSearchSchema>

// a search that does not parse is the default
export function parseIndexSearch(raw: Record<string, unknown>): IndexSearch {
	const res = IndexSearchSchema.safeParse(raw)
	return res.success ? res.data : {}
}

// the search as its url spells it: defaults and empty values left out
export function compactIndexSearch(search: IndexSearch): IndexSearch {
	const out: IndexSearch = {}
	if (search.q?.trim()) out.q = search.q
	if (search.author) out.author = search.author
	if (search.sort && search.sort !== 'default') out.sort = search.sort
	if (search.dir && search.dir !== 'asc') out.dir = search.dir
	return out
}

// the filters a search shows, in the order it shows them
export function searchFilters(filters: Iterable<F.FilterEntity>, search: IndexSearch, isPoolFilter: (filter: F.FilterEntity) => boolean) {
	const q = search.q?.trim().toLowerCase()
	const out: F.FilterEntity[] = []
	for (const filter of filters) {
		if (search.author && F.ownerKey(filter.owner) !== search.author) continue
		if (q && !`${filter.name}\n${filter.description ?? ''}`.toLowerCase().includes(q)) continue
		out.push(filter)
	}
	const sort = search.sort ?? 'default'
	const sign = (search.dir ?? 'asc') === 'asc' ? 1 : -1
	out.sort((a, b) => {
		switch (sort) {
			case 'default': {
				if (isPoolFilter(a) !== isPoolFilter(b)) return sign * (isPoolFilter(a) ? -1 : 1)
				if (!!a.emoji !== !!b.emoji) return sign * (a.emoji ? -1 : 1)
				return sign * a.name.localeCompare(b.name)
			}
			case 'name':
				return sign * a.name.localeCompare(b.name)
			default:
				assertNever(sort)
		}
	})
	return out
}

// the first part of the filter that matches the query, with the match split out
export function matchSnippet(filter: F.FilterEntity, query: string): { before: string; hit: string; after: string } | null {
	const q = query.toLowerCase()
	for (const text of [filter.name, ...(filter.description ?? '').split('\n')]) {
		const at = text.toLowerCase().indexOf(q)
		if (at === -1) continue
		const start = Math.max(0, at - 24)
		return {
			before: (start > 0 ? '…' : '') + text.slice(start, at),
			hit: text.slice(at, at + q.length),
			after: text.slice(at + q.length, at + q.length + 48),
		}
	}
	return null
}
