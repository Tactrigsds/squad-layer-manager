// A rotation is a saved, ordered list of queue items, kept so it can be added to a server's queue in one go.
// Its items carry no attribution: no source, no tag attribution and no note authors, so a rotation reads the same
// whoever made it and survives an export and import intact (see anonymize).
import type * as SchemaModels from '$root/drizzle/schema.models'
import * as Str from '@/lib/string-utils'
import { assertNever } from '@/lib/type-guards'
import { z } from '@/lib/zod'
import * as F from '@/models/filter.models'
import * as LL from '@/models/layer-list.models'
import * as LNote from '@/models/layer-notes.models'
import * as LTag from '@/models/layer-tags.models'
import type * as L from '@/models/layer.models'
import * as RRS from '@/models/repeat-rulesets.models'

export const RotationIdSchema = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.regex(/^[a-z0-9_-]+$/, { error: 'Must contain only lowercase letters, numbers, hyphens, and underscores' })
export type RotationId = z.infer<typeof RotationIdSchema>

export const NameSchema = z.string().trim().min(3).max(128)
export const DescriptionSchema = F.DescriptionSchema

// the same owners a filter has, labelled the way an actor is
export const OwnerSchema = F.FilterOwnerSchema
export type Owner = F.FilterOwner

export const RotationSchema = z.object({
	id: RotationIdSchema,
	name: NameSchema,
	description: DescriptionSchema.nullable(),
	items: LL.ListSchema,
	repeatRulesetId: RRS.RulesetIdSchema.nullable(),
	// rotation tags, defined in the global settings under rotationTags
	tags: z.array(LTag.TagIdSchema),
	archived: z.boolean(),
	owner: OwnerSchema,
	createdAt: z.number().int(),
	updatedAt: z.number().int(),
})
export type Rotation = z.infer<typeof RotationSchema>

// the fields set when a rotation is created; the rest are filled in by the server
export const NewRotationSchema = RotationSchema.pick({ id: true, name: true, description: true, repeatRulesetId: true, tags: true }).extend(
	{
		items: LL.ListSchema.optional(),
	},
)
export type NewRotation = z.infer<typeof NewRotationSchema>

// the fields edited outside the shared list draft, which save as soon as they are changed
export const MetaPatchSchema = RotationSchema.pick({
	name: true,
	description: true,
	repeatRulesetId: true,
	tags: true,
	archived: true,
}).partial()
export type MetaPatch = z.infer<typeof MetaPatchSchema>

export const UpdatePatchSchema = MetaPatchSchema.extend({ items: LL.ListSchema.optional() })
export type UpdatePatch = z.infer<typeof UpdatePatchSchema>

export const CloneInputSchema = z.object({
	sourceId: RotationIdSchema,
	id: RotationIdSchema,
	name: NameSchema,
	copyTags: z.boolean(),
	copyContributors: z.boolean(),
})
export type CloneInput = z.infer<typeof CloneInputSchema>

const UNKNOWN_SOURCE: LL.Source = { type: 'unknown' }

function anonymizeSingle(item: LL.SingleItem): LL.SingleItem {
	const { tagsSetBy: _tagsSetBy, notes, ...rest } = item
	const out: LL.SingleItem = { ...rest, source: UNKNOWN_SOURCE }
	if (notes && notes.length > 0) out.notes = notes.map(({ author: _author, ...note }) => note)
	return out
}

// strips everything that names a person or records what happened to an item, keeping the layers, the tags and the
// note text. A vote keeps its choices and display options; how a past vote ended is dropped.
export function anonymize(list: LL.List): LL.List {
	return list.map((item): LL.Item => {
		if (item.type === 'single-list-item') return anonymizeSingle(item)
		const { endingVoteState: _endingVoteState, voteConfig, ...rest } = item
		const out: LL.VoteItem = {
			...rest,
			layerId: item.choices[0].layerId,
			source: UNKNOWN_SOURCE,
			choices: item.choices.map(anonymizeSingle),
		}
		if (voteConfig) out.voteConfig = { ...voteConfig, source: UNKNOWN_SOURCE }
		return out
	})
}

// a rotation's items as new queue items: fresh ids, the rotation's from-rotation tag, and notes that name the rotation.
// Vote choices are stamped with `source`, since the add op only stamps the outer item.
export function toQueueItems(rotation: Pick<Rotation, 'id' | 'items'>, source: LL.Source): LL.NewItem[] {
	const tag = LTag.fromRotationTagId(rotation.id)
	const single = (item: LL.SingleItem): LL.SingleItem => {
		const { tagsSetBy: _tagsSetBy, notes, ...rest } = item
		const out: LL.SingleItem = { ...rest, itemId: LL.createItemId(), source, tags: [...new Set([...(item.tags ?? []), tag])] }
		if (notes && notes.length > 0) {
			out.notes = notes.map(({ author: _author, ...note }) => ({ ...note, id: LNote.createNoteId(), fromRotation: rotation.id }))
		}
		return out
	}
	return rotation.items.map((item): LL.NewItem => {
		if (item.type === 'single-list-item') {
			const { source: _source, ...rest } = single(item)
			return rest
		}
		const { endingVoteState: _endingVoteState, source: _source, voteConfig, ...rest } = item
		const choices = item.choices.map(single)
		const out: LL.NewVoteItem = { ...rest, itemId: LL.createItemId(), layerId: choices[0].layerId, choices }
		if (voteConfig) out.voteConfig = { ...voteConfig, source }
		return out
	})
}

export function idFromName(name: string): RotationId {
	return Str.slugify(name, 64) || 'rotation'
}

// -------- the rotations page's search, kept in its url --------

export const INDEX_SORT = z.enum(['modified', 'created', 'name'])
export type IndexSort = z.infer<typeof INDEX_SORT>

// `author` is an owner key (see F.ownerKey)
export const IndexSearchSchema = z.object({
	q: z.string().optional(),
	tags: z.array(LTag.TagIdSchema).optional(),
	author: z.string().optional(),
	sort: INDEX_SORT.optional(),
	dir: z.enum(['asc', 'desc']).optional(),
	archived: z.boolean().optional(),
})
export type IndexSearch = z.infer<typeof IndexSearchSchema>

// a search that does not parse is the default; a single tag may arrive as a bare string
export function parseIndexSearch(raw: Record<string, unknown>): IndexSearch {
	const tags = typeof raw.tags === 'string' ? [raw.tags] : raw.tags
	const res = IndexSearchSchema.safeParse({ ...raw, tags })
	return res.success ? res.data : {}
}

// the search as its url spells it: defaults and empty values left out
export function compactIndexSearch(search: IndexSearch): IndexSearch {
	const out: IndexSearch = {}
	if (search.q?.trim()) out.q = search.q
	if (search.tags?.length) out.tags = search.tags
	if (search.author) out.author = search.author
	if (search.sort && search.sort !== 'modified') out.sort = search.sort
	if (search.dir && search.dir !== defaultDir(search.sort ?? 'modified')) out.dir = search.dir
	if (search.archived) out.archived = true
	return out
}

// newest first for the dates, alphabetical for names
export function defaultDir(sort: IndexSort): 'asc' | 'desc' {
	return sort === 'name' ? 'asc' : 'desc'
}

// -------- listing without items --------
// Rotations are unbounded in number and size, so lists, pickers and live updates carry summaries, and only a rotation
// that is open is sent in full.

export const PREVIEW_ITEMS = 3

// what a rotation and a summary of it share
export type Meta = Omit<Rotation, 'items'>

export type Summary = Meta & {
	itemCount: number
	// the first PREVIEW_ITEMS items
	previewItems: { itemId: string; layerId: L.LayerId }[]
}

export function toSummary({ items, ...rest }: Rotation): Summary {
	return {
		...rest,
		itemCount: items.length,
		previewItems: items.slice(0, PREVIEW_ITEMS).map(({ itemId, layerId }) => ({ itemId, layerId })),
	}
}

export const SEARCH_PAGE_SIZE = 60

// where the next page starts: the sort column's value and the id of the last rotation on the page
export const SearchCursorSchema = z.object({ sortValue: z.union([z.number(), z.string()]), id: RotationIdSchema })
export type SearchCursor = z.infer<typeof SearchCursorSchema>

// `q` matches the name and the description. An archived rotation matches only when `archived` is set.
export const SearchInputSchema = IndexSearchSchema.extend({
	cursor: SearchCursorSchema.optional(),
	limit: z.number().int().min(1).max(200).optional(),
})
export type SearchInput = z.infer<typeof SearchInputSchema>

// `matched` counts every rotation the search matches, and is given only on the first page
export type SearchPage = { rotations: Summary[]; nextCursor: SearchCursor | null; matched?: number }

// counts over every rotation, for the rotations page's filters
export type Facets = {
	unarchived: number
	archived: number
	// rotations per tag, archived ones included
	tagCounts: Record<LTag.TagId, number>
	owners: Owner[]
}

export function sortValue(summary: Summary, sort: IndexSort): number | string {
	switch (sort) {
		case 'name':
			return summary.name
		case 'created':
			return summary.createdAt
		case 'modified':
			return summary.updatedAt
		default:
			assertNever(sort)
	}
}

// a row as unsuperjsonify hands it back
export function fromRow(row: SchemaModels.Rotation): Rotation {
	return RotationSchema.parse({
		...row,
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime(),
		owner: ownerFromColumns(row),
	})
}

export function ownerFromColumns(row: Pick<SchemaModels.Rotation, 'ownerUserId' | 'ownerPluginId'>): Owner {
	if (row.ownerUserId !== null) return { type: 'slm-user', userId: row.ownerUserId }
	if (row.ownerPluginId !== null) return { type: 'plugin', pluginId: row.ownerPluginId }
	return F.SYSTEM_OWNER
}

// a row for superjsonify, which encodes the json columns
export function toRow({ owner, createdAt, updatedAt, items, ...rest }: Rotation): SchemaModels.NewRotation {
	return {
		...rest,
		items: z.encode(LL.ListSchema, items),
		...F.ownerColumns(owner),
		createdAt: new Date(createdAt),
		updatedAt: new Date(updatedAt),
	}
}

export type Mutation = {
	type: 'add' | 'update' | 'delete'
	key: RotationId
	value: Rotation
}

// a Mutation as clients receive it
export type SummaryMutation = {
	type: Mutation['type']
	key: RotationId
	value: Summary
}
