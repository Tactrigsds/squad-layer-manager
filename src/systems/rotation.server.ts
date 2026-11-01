// Rotations: their rows, who may edit them, and what clients watch of them. Rotations are unbounded in number and
// size, so nothing holds all of them: clients search summaries page by page, are told which rotation changed, and
// watch an open rotation in full. The shared draft of one rotation's items is in rotation-edit.server.ts, which writes
// here when a draft is saved.
import * as E from 'drizzle-orm'

import type * as SchemaModels from '$root/drizzle/schema.models'
import * as Schema from '$root/drizzle/schema.ts'
import { IsolatedSubject } from '@/lib/isolated-subject'
import * as Obj from '@/lib/object-utils'
import * as Rx from '@/lib/rxjs'
import { assertNever } from '@/lib/type-guards'
import type { Parts } from '@/lib/types'
import { z } from '@/lib/zod'
import * as AppEvents from '@/models/app-events.models'
import * as CS from '@/models/context-shared.models'
import * as F from '@/models/filter.models'
import * as RRS from '@/models/repeat-rulesets.models'
import * as ROT from '@/models/rotations.models'
import type * as USR from '@/models/users.models'
import * as RBAC from '@/rbac.models'
import type * as C from '@/server/context'
import * as DB from '@/server/db'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as Sql from '@/server/sql'
import * as AppEventsSys from '@/systems/app-events.server'
import * as Rbac from '@/systems/rbac.server'
import * as Settings from '@/systems/settings.server'
import * as Users from '@/systems/users.server'

const module = initModule('rotation')
let log!: CS.Logger
const orpcBase = getOrpcBase(module)
const SQL = Sql.forModule(module)

const T = Schema.rotations
const UserContributors = Schema.rotationUserContributors
const RoleContributors = Schema.rotationRoleContributors

export const rotationMutation$ = new IsolatedSubject<[C.Db & CS.Otel, ROT.Mutation & { actor: AppEvents.Actor }]>()

const ToggleContributorInputSchema = z
	.object({ rotationId: ROT.RotationIdSchema, userId: z.bigint().optional(), roleId: RBAC.UserDefinedRoleIdSchema.optional() })
	.refine((input) => input.userId || input.roleId, { error: 'Either userId or role must be provided' })
type ToggleContributorInput = z.infer<typeof ToggleContributorInputSchema>

const MAX_NAME_LOOKUPS = 200

// the columns Users.buildUsers reads
const USER_COLUMNS = {
	discordId: Schema.users.discordId,
	nickname: Schema.users.nickname,
	username: Schema.discordAccounts.username,
}

namespace Q {
	// -------- statements --------

	const idP = SQL.params({ id: T.id })
	export const rotationById = SQL.def('rotationById', idP, SQL.select().from(T).where(E.eq(T.id, idP.id)))
	export const rotationName = SQL.def('rotationName', idP, SQL.select({ name: T.name }).from(T).where(E.eq(T.id, idP.id)))
	export const rotationOwner = SQL.def('rotationOwner', idP, SQL.select({ ownerUserId: T.ownerUserId }).from(T).where(E.eq(T.id, idP.id)))
	export const deleteRotationRow = SQL.def('deleteRotationRow', idP, SQL.delete(T).where(E.eq(T.id, idP.id)))
	const rotationP = SQL.params(E.getTableColumns(T))
	export const insertRotation = SQL.def('insertRotation', rotationP, SQL.insert(T).values(rotationP).onConflictDoNothing())
	const { id: _id, ...rotationSetP } = rotationP
	export const updateRotationRow = SQL.def('updateRotationRow', rotationP, SQL.update(T).set(rotationSetP).where(E.eq(T.id, rotationP.id)))
	const rotationIdsP = SQL.params({ ids: SQL.list(T.id) })
	export const rotationNames = SQL.def(
		'rotationNames',
		rotationIdsP,
		SQL.select({ id: T.id, name: T.name }).from(T).where(SQL.inJson(T.id, rotationIdsP.ids)),
	)
	const cloneIdP = SQL.params({ base: T.id, needle: SQL.value<string>() })
	export const cloneIdsTaken = SQL.def(
		'cloneIdsTaken',
		cloneIdP,
		SQL.select({ id: T.id })
			.from(T)
			.where(E.or(E.eq(T.id, cloneIdP.base), E.sql`${T.id} LIKE ${cloneIdP.needle} ESCAPE '\\'`)),
		{ scans: ['rotations'] },
	)
	export const archivedCounts = SQL.def(
		'archivedCounts',
		SQL.params({}),
		SQL.select({
			unarchived: E.sql<number>`coalesce(sum(${T.archived} = 0), 0)`,
			archived: E.sql<number>`coalesce(sum(${T.archived} = 1), 0)`,
		}).from(T),
		{ scans: ['rotations'] },
	)
	export const tagCounts = SQL.def(
		'tagCounts',
		SQL.params({}),
		SQL.select({ tag: E.sql<string>`j.value`, n: E.sql<number>`count(*)` })
			.from(E.sql`${T}, json_each(${T.tags}, '$.json') AS j`)
			.groupBy(E.sql`j.value`),
		{ scans: ['rotations'] },
	)
	export const rotationOwners = SQL.def(
		'rotationOwners',
		SQL.params({}),
		SQL.selectDistinct({ ownerUserId: T.ownerUserId, ownerPluginId: T.ownerPluginId }).from(T),
		{ scans: ['rotations'] },
	)
	export const repeatRulesetIdsInUse = SQL.def(
		'repeatRulesetIdsInUse',
		SQL.params({}),
		SQL.selectDistinct({ repeatRulesetId: T.repeatRulesetId }).from(T).where(E.isNotNull(T.repeatRulesetId)),
		{ scans: ['rotations'] },
	)
	const userContributorsP = SQL.params({ rotationId: UserContributors.rotationId })
	export const userContributorIds = SQL.def(
		'userContributorIds',
		userContributorsP,
		SQL.select({ userId: UserContributors.userId })
			.from(UserContributors)
			.where(E.eq(UserContributors.rotationId, userContributorsP.rotationId)),
	)
	const roleContributorsP = SQL.params({ rotationId: RoleContributors.rotationId })
	export const roleContributorIds = SQL.def(
		'roleContributorIds',
		roleContributorsP,
		SQL.select({ roleId: RoleContributors.roleId })
			.from(RoleContributors)
			.where(E.eq(RoleContributors.rotationId, roleContributorsP.rotationId)),
	)
	const userContributorP = SQL.params({ rotationId: UserContributors.rotationId, userId: UserContributors.userId })
	export const insertUserContributor = SQL.def(
		'insertUserContributor',
		userContributorP,
		SQL.insert(UserContributors)
			.values({ rotationId: userContributorP.rotationId, userId: userContributorP.userId })
			.onConflictDoNothing(),
	)
	export const deleteUserContributor = SQL.def(
		'deleteUserContributor',
		userContributorP,
		SQL.delete(UserContributors).where(
			E.and(E.eq(UserContributors.rotationId, userContributorP.rotationId), E.eq(UserContributors.userId, userContributorP.userId)),
		),
	)
	const roleContributorP = SQL.params({ rotationId: RoleContributors.rotationId, roleId: RoleContributors.roleId })
	export const insertRoleContributor = SQL.def(
		'insertRoleContributor',
		roleContributorP,
		SQL.insert(RoleContributors)
			.values({ rotationId: roleContributorP.rotationId, roleId: roleContributorP.roleId })
			.onConflictDoNothing(),
	)
	export const deleteRoleContributor = SQL.def(
		'deleteRoleContributor',
		roleContributorP,
		SQL.delete(RoleContributors).where(
			E.and(E.eq(RoleContributors.rotationId, roleContributorP.rotationId), E.eq(RoleContributors.roleId, roleContributorP.roleId)),
		),
	)
	const userIdP = SQL.params({ userId: Schema.users.discordId })
	export const userExists = SQL.def(
		'userExists',
		userIdP,
		SQL.select({ id: Schema.users.discordId }).from(Schema.users).where(E.eq(Schema.users.discordId, userIdP.userId)),
	)
	const userIdsP = SQL.params({ ids: SQL.list(Schema.users.discordId) })
	export const usersByIds = SQL.def(
		'usersByIds',
		userIdsP,
		SQL.select(USER_COLUMNS)
			.from(Schema.users)
			.innerJoin(Schema.discordAccounts, E.eq(Schema.users.discordId, Schema.discordAccounts.discordId))
			.where(SQL.inJson(Schema.users.discordId, userIdsP.ids)),
	)
	export const contributingUsers = SQL.def(
		'contributingUsers',
		userContributorsP,
		SQL.select(USER_COLUMNS)
			.from(UserContributors)
			.innerJoin(Schema.users, E.eq(Schema.users.discordId, UserContributors.userId))
			.innerJoin(Schema.discordAccounts, E.eq(Schema.users.discordId, Schema.discordAccounts.discordId))
			.where(E.eq(UserContributors.rotationId, userContributorsP.rotationId)),
	)
}

// -------- helpers --------

function recordChange(
	ctx: C.Db,
	actor: AppEvents.Actor,
	action: AppEvents.RotationChanged['action'],
	rotation: ROT.Rotation,
	details?: { changedFields?: string[]; clonedFrom?: ROT.RotationId },
) {
	AppEventsSys.persistAppEvent(
		ctx,
		AppEvents.create<AppEvents.RotationChanged>({
			type: 'ROTATION_CHANGED',
			action,
			rotationId: rotation.id,
			rotationName: rotation.name,
			changedFields: details?.changedFields,
			clonedFrom: details?.clonedFrom,
			actor,
			serverId: null,
			matchId: null,
			causeId: null,
		}),
	)
}

function recordContributor(
	ctx: C.Db,
	action: AppEvents.RotationContributorChanged['action'],
	rotationId: ROT.RotationId,
	contributor: RBAC.Contributor,
	actor: AppEvents.Actor,
) {
	const row = DB.get(ctx, Q.rotationName({ id: rotationId }))
	AppEventsSys.persistAppEvent(
		ctx,
		AppEvents.create<AppEvents.RotationContributorChanged>({
			type: 'ROTATION_CONTRIBUTOR_CHANGED',
			action,
			rotationId,
			rotationName: row?.name,
			contributor,
			actor,
			serverId: null,
			matchId: null,
			causeId: null,
		}),
	)
}

function toContributor(input: ToggleContributorInput): RBAC.Contributor {
	return input.userId !== undefined ? { type: 'user', userId: input.userId } : { type: 'role', roleId: input.roleId! }
}

function invalidateContributor(contributor: RBAC.Contributor) {
	if (contributor.type === 'user') Rbac.invalidateUser(contributor.userId)
	else Rbac.invalidateAll()
}

export function listContributors(ctx: C.Db, rotationId: ROT.RotationId): RBAC.Contributor[] {
	const users = DB.all(ctx, Q.userContributorIds({ rotationId }))
	const roles = DB.all(ctx, Q.roleContributorIds({ rotationId }))
	return [
		...users.map((u): RBAC.Contributor => ({ type: 'user', userId: u.userId })),
		...roles.map((r): RBAC.Contributor => ({ type: 'role', roleId: r.roleId })),
	]
}

// checked up front because a missing rotation or user would otherwise fail the insert's foreign key
export const addContributor = DB.txOp(
	'addContributor',
	{ module },
	(ctx: C.Db & C.Tx, rotationId: ROT.RotationId, contributor: RBAC.Contributor, actor: AppEvents.Actor) => {
		if (!DB.get(ctx, Q.rotationName({ id: rotationId }))) return { code: 'err:not-found' as const }
		const changes = { changes: { atLeast: 1 }, otherwise: 'err:already-exists' as const }
		let res
		switch (contributor.type) {
			case 'user': {
				if (!DB.get(ctx, Q.userExists({ userId: contributor.userId }))) return { code: 'err:unknown-user' as const }
				res = DB.run(ctx, Q.insertUserContributor({ rotationId, userId: contributor.userId }), changes)
				break
			}
			case 'role':
				res = DB.run(ctx, Q.insertRoleContributor({ rotationId, roleId: contributor.roleId }), changes)
				break
			default:
				assertNever(contributor)
		}
		if (res.code !== 'ok') return { code: res.code }
		recordContributor(ctx, 'added', rotationId, contributor, actor)
		DB.afterCommit(ctx, () => invalidateContributor(contributor))
		return { code: 'ok' as const }
	},
)

export const removeContributor = DB.txOp(
	'removeContributor',
	{ module },
	(ctx: C.Db & C.Tx, rotationId: ROT.RotationId, contributor: RBAC.Contributor, actor: AppEvents.Actor) => {
		const changes = { changes: { atLeast: 1 }, otherwise: 'err:not-found' as const }
		let res
		switch (contributor.type) {
			case 'user':
				res = DB.run(ctx, Q.deleteUserContributor({ rotationId, userId: contributor.userId }), changes)
				break
			case 'role':
				res = DB.run(ctx, Q.deleteRoleContributor({ rotationId, roleId: contributor.roleId }), changes)
				break
			default:
				assertNever(contributor)
		}
		if (res.code !== 'ok') return { code: res.code }
		recordContributor(ctx, 'removed', rotationId, contributor, actor)
		DB.afterCommit(ctx, () => invalidateContributor(contributor))
		return { code: 'ok' as const }
	},
)

// a subscriber runs its statements after the emitting transaction has ended
function outsideTx(ctx: C.Db): C.Db {
	const { tx: _tx, ...rest } = ctx as C.Db & Partial<C.Tx>
	return rest
}

function emit(ctx: C.Db, mutation: ROT.Mutation, actor: AppEvents.Actor) {
	rotationMutation$.next([CS.storeLinkToActiveSpan(outsideTx(ctx), 'event.emitter'), { ...mutation, actor }])
}

function unknownRepeatRulesetError(repeatRulesetId: RRS.RulesetId | null | undefined) {
	if (!repeatRulesetId || RRS.find(Settings.GLOBAL_SETTINGS.repeatRulesets, repeatRulesetId)) return undefined
	return { code: 'err:unknown-repeat-ruleset' as const, message: `No ruleset has the id "${repeatRulesetId}"` }
}

function unknownTagsError(tags: readonly string[] | undefined) {
	if (!tags) return undefined
	const known = new Set(Settings.GLOBAL_SETTINGS.rotationTags.map((t) => t.id))
	const unknown = tags.filter((id) => !known.has(id))
	if (unknown.length === 0) return undefined
	return { code: 'err:unknown-tags' as const, message: `Unknown rotation tags: ${unknown.join(', ')}` }
}

// Managing who can contribute is an ownership concern, so it's restricted to the owner, or anyone with blanket write
// access, rather than any contributor who merely has rotations:write for the rotation.
async function denyUnlessOwner(ctx: C.Db & USR.Ctx.Id & CS.AbortSignal, rotationId: ROT.RotationId) {
	const row = DB.get(ctx, Q.rotationOwner({ id: rotationId }))
	if (row && row.ownerUserId === ctx.user.discordId) return null
	return Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('rotations:write-all'))
}

// ROT.toRow types the nullable columns as optional, and a Rotation carries every one
function rotationRow(rotation: ROT.Rotation) {
	return ROT.toRow(rotation) as SchemaModels.Rotation
}

export function getRotation(ctx: C.Db, id: ROT.RotationId): ROT.Rotation | undefined {
	const row = DB.get(ctx, Q.rotationById({ id }))
	return row ? ROT.fromRow(row) : undefined
}

// -------- summaries --------

// a row without its items, with what the summary keeps of them computed by sqlite
const SUMMARY_COLUMNS = {
	id: T.id,
	name: T.name,
	description: T.description,
	repeatRulesetId: T.repeatRulesetId,
	tags: E.sql<string>`json_extract(${T.tags}, '$.json')`,
	archived: T.archived,
	ownerUserId: T.ownerUserId,
	ownerPluginId: T.ownerPluginId,
	createdAt: T.createdAt,
	updatedAt: T.updatedAt,
	itemCount: E.sql<number>`json_array_length(${T.items}, '$.json')`,
	previewItems: E.sql<string>`(SELECT json_group_array(json_object('itemId', json_extract(value, '$.itemId'), 'layerId', json_extract(value, '$.layerId'))) FROM json_each(${T.items}, '$.json') WHERE key < ${ROT.PREVIEW_ITEMS})`,
}

type SummaryRow = {
	id: string
	name: string
	description: string | null
	repeatRulesetId: string | null
	tags: string
	archived: boolean
	ownerUserId: bigint | null
	ownerPluginId: string | null
	createdAt: Date
	updatedAt: Date
	itemCount: number
	previewItems: string
}

function toSummary(row: SummaryRow): ROT.Summary {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		repeatRulesetId: row.repeatRulesetId,
		tags: JSON.parse(row.tags),
		archived: row.archived,
		owner: ROT.ownerFromColumns(row),
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime(),
		itemCount: row.itemCount,
		previewItems: JSON.parse(row.previewItems),
	}
}

function ownerCondition(ownerKey: string): E.SQL {
	if (ownerKey === 'system') return E.and(E.isNull(T.ownerUserId), E.isNull(T.ownerPluginId))!
	const [type, id] = [ownerKey.slice(0, ownerKey.indexOf(':')), ownerKey.slice(ownerKey.indexOf(':') + 1)]
	if (type === 'user' && /^\d+$/.test(id)) return E.eq(T.ownerUserId, BigInt(id))
	if (type === 'plugin') return E.eq(T.ownerPluginId, id)
	return E.sql`false`
}

function searchCondition(search: ROT.IndexSearch): E.SQL | undefined {
	const conds: E.SQL[] = []
	if (!search.archived) conds.push(E.eq(T.archived, false))
	for (const tag of search.tags ?? []) {
		conds.push(E.sql`EXISTS (SELECT 1 FROM json_each(${T.tags}, '$.json') WHERE value = ${tag})`)
	}
	if (search.author) conds.push(ownerCondition(search.author))
	const q = search.q?.trim()
	if (q) {
		const needle = `%${q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
		conds.push(E.or(E.sql`${T.name} LIKE ${needle} ESCAPE '\\'`, E.sql`${T.description} LIKE ${needle} ESCAPE '\\'`)!)
	}
	return E.and(...conds)
}

// the sort column, compared as the cursor's sortValue is
function sortColumn(sort: ROT.IndexSort): E.SQL {
	switch (sort) {
		case 'name':
			return E.sql`${T.name} COLLATE NOCASE`
		case 'created':
			return E.sql`${T.createdAt}`
		case 'modified':
			return E.sql`${T.updatedAt}`
		default:
			assertNever(sort)
	}
}

// Pages by keyset rather than offset, so a rotation saved while someone pages through doesn't shift the pages after it.
// Built per call: the filters, sort and cursor each change the statement's shape.
export function searchSummaries(ctx: C.Db, input: ROT.SearchInput): ROT.SearchPage {
	const sort = input.sort ?? 'modified'
	const dir = input.dir ?? ROT.defaultDir(sort)
	const limit = input.limit ?? ROT.SEARCH_PAGE_SIZE
	const col = sortColumn(sort)
	const where = searchCondition(input)
	const after = input.cursor
		? dir === 'asc'
			? E.sql`(${col} > ${input.cursor.sortValue} OR (${col} = ${input.cursor.sortValue} AND ${T.id} > ${input.cursor.id}))`
			: E.sql`(${col} < ${input.cursor.sortValue} OR (${col} = ${input.cursor.sortValue} AND ${T.id} < ${input.cursor.id}))`
		: undefined
	const order = dir === 'asc' ? [E.asc(col), E.asc(T.id)] : [E.desc(col), E.desc(T.id)]
	const rows = DB.all(
		ctx,
		SQL.select(SUMMARY_COLUMNS)
			.from(T)
			.where(E.and(where, after))
			.orderBy(...order)
			.limit(limit + 1),
	) as SummaryRow[]
	const rotations = rows.slice(0, limit).map(toSummary)
	const last = rotations.at(-1)
	const nextCursor = rows.length > limit && last ? { sortValue: ROT.sortValue(last, sort), id: last.id } : null
	if (input.cursor) return { rotations, nextCursor }
	const { matched } = DB.get(ctx, SQL.select({ matched: E.count() }).from(T).where(where))!
	return { rotations, nextCursor, matched }
}

export function getFacets(ctx: C.Db): ROT.Facets {
	const counts = DB.get(ctx, Q.archivedCounts({}))!
	const tagRows = DB.all(ctx, Q.tagCounts({}))
	const ownerRows = DB.all(ctx, Q.rotationOwners({}))
	return {
		unarchived: counts.unarchived,
		archived: counts.archived,
		tagCounts: Object.fromEntries(tagRows.map((r) => [r.tag, r.n])),
		owners: ownerRows.map(ROT.ownerFromColumns),
	}
}

async function usersOf(ctx: C.Db, owners: Iterable<ROT.Owner>, extra: Iterable<bigint> = []) {
	const ids = new Set<bigint>(extra)
	for (const owner of owners) {
		const userId = F.ownerUserId(owner)
		if (userId !== null) ids.add(userId)
	}
	const dbUsers = ids.size > 0 ? DB.all(ctx, Q.usersByIds({ ids: [...ids] })) : []
	return await Users.buildUsers(dbUsers)
}

// -------- writes --------
// The write paths below take no permission check, which stays with the rpc handlers: the editing session and plugins
// write a rotation the same way a person does.

export const createRotation = DB.txOp(
	'createRotation',
	{ module },
	(ctx: C.Db & C.Tx, input: ROT.NewRotation & { owner: ROT.Owner }, actor: AppEvents.Actor, opts?: { clonedFrom?: ROT.RotationId }) => {
		const repeatRulesetError = unknownRepeatRulesetError(input.repeatRulesetId)
		if (repeatRulesetError) return repeatRulesetError
		const tagsError = unknownTagsError(input.tags)
		if (tagsError) return tagsError
		const now = Date.now()
		const rotation: ROT.Rotation = {
			id: input.id,
			name: input.name,
			description: input.description,
			items: ROT.anonymize(input.items ?? []),
			repeatRulesetId: input.repeatRulesetId,
			tags: input.tags,
			archived: false,
			owner: input.owner,
			createdAt: now,
			updatedAt: now,
		}
		const res = DB.run(ctx, Q.insertRotation(rotationRow(rotation)), { changes: { atLeast: 1 }, otherwise: 'err:already-exists' })
		if (res.code !== 'ok') return { code: res.code }
		recordChange(ctx, actor, 'created', rotation, { clonedFrom: opts?.clonedFrom })
		DB.afterCommit(ctx, () => {
			emit(ctx, { type: 'add', key: rotation.id, value: rotation }, actor)
			const ownerUserId = F.ownerUserId(rotation.owner)
			if (ownerUserId !== null) Rbac.invalidateUser(ownerUserId)
			log.info('created rotation %s', rotation.id)
		})
		return { code: 'ok' as const, rotation }
	},
)

export const updateRotation = DB.txOp(
	'updateRotation',
	{ module },
	(ctx: C.Db & C.Tx, id: ROT.RotationId, patch: ROT.UpdatePatch, actor: AppEvents.Actor) => {
		const repeatRulesetError = unknownRepeatRulesetError(patch.repeatRulesetId)
		if (repeatRulesetError) return repeatRulesetError
		const tagsError = unknownTagsError(patch.tags)
		if (tagsError) return tagsError
		const prev = getRotation(ctx, id)
		if (!prev) return { code: 'err:not-found' as const }
		const next: ROT.Rotation = {
			...prev,
			...Obj.trimUndefined(patch),
			...(patch.items ? { items: ROT.anonymize(patch.items) } : {}),
			updatedAt: Date.now(),
		}
		const changedFields = (Object.keys(patch) as (keyof ROT.UpdatePatch)[]).filter(
			(field) => patch[field] !== undefined && !Obj.deepEqual(prev[field], next[field]),
		)
		if (changedFields.length === 0) return { code: 'ok' as const, rotation: prev }
		DB.run(ctx, Q.updateRotationRow(rotationRow(next)))
		recordChange(ctx, actor, 'updated', next, { changedFields })
		DB.afterCommit(ctx, () => emit(ctx, { type: 'update', key: id, value: next }, actor))
		return { code: 'ok' as const, rotation: next }
	},
)

export const deleteRotation = DB.txOp('deleteRotation', { module }, (ctx: C.Db & C.Tx, id: ROT.RotationId, actor: AppEvents.Actor) => {
	const rotation = getRotation(ctx, id)
	if (!rotation) return { code: 'err:not-found' as const }
	// captured before the delete so the affected inferred-role holders can be invalidated after commit
	const userContributorIdList = DB.all(ctx, Q.userContributorIds({ rotationId: id })).map((r) => r.userId)
	const hasRoleContributors = DB.all(ctx, Q.roleContributorIds({ rotationId: id })).length > 0
	DB.run(ctx, Q.deleteRotationRow({ id }))
	recordChange(ctx, actor, 'deleted', rotation)
	DB.afterCommit(ctx, () => {
		if (hasRoleContributors) Rbac.invalidateAll()
		else {
			const ownerUserId = F.ownerUserId(rotation.owner)
			if (ownerUserId !== null) Rbac.invalidateUser(ownerUserId)
			for (const userId of userContributorIdList) Rbac.invalidateUser(userId)
		}
		emit(ctx, { type: 'delete', key: id, value: rotation }, actor)
	})
	return { code: 'ok' as const }
})

export const cloneRotation = DB.txOp(
	'cloneRotation',
	{ module },
	(ctx: C.Db & C.Tx, input: ROT.CloneInput, owner: ROT.Owner, actor: AppEvents.Actor) => {
		const source = getRotation(ctx, input.sourceId)
		if (!source) return { code: 'err:not-found' as const }
		const res = createRotation(
			ctx,
			{
				id: input.id,
				name: input.name,
				description: source.description,
				items: source.items,
				repeatRulesetId: source.repeatRulesetId,
				tags: input.copyTags ? source.tags : [],
				owner,
			},
			actor,
			{ clonedFrom: source.id },
		)
		if (res.code !== 'ok' || !input.copyContributors) return res
		insertContributorsFrom(ctx, source.id, input.id, actor)
		return res
	},
)

/** Adds the source's contributors to the target's. Contributors the target already has are kept. */
export const copyContributors = DB.txOp(
	'copyContributors',
	{ module },
	(ctx: C.Db & C.Tx, sourceId: ROT.RotationId, targetId: ROT.RotationId, actor: AppEvents.Actor) => {
		const found = DB.all(ctx, Q.rotationNames({ ids: [sourceId, targetId] }))
		if (!found.some((r) => r.id === sourceId) || !found.some((r) => r.id === targetId)) return { code: 'err:not-found' as const }
		insertContributorsFrom(ctx, sourceId, targetId, actor)
		return { code: 'ok' as const }
	},
)

// records an event only for the contributors it actually added
function insertContributorsFrom(ctx: C.Db, sourceId: ROT.RotationId, targetId: ROT.RotationId, actor: AppEvents.Actor) {
	const added: RBAC.Contributor[] = []
	for (const { userId } of DB.all(ctx, Q.userContributorIds({ rotationId: sourceId }))) {
		if (DB.run(ctx, Q.insertUserContributor({ rotationId: targetId, userId })).changes > 0) added.push({ type: 'user', userId })
	}
	for (const { roleId } of DB.all(ctx, Q.roleContributorIds({ rotationId: sourceId }))) {
		if (DB.run(ctx, Q.insertRoleContributor({ rotationId: targetId, roleId })).changes > 0) added.push({ type: 'role', roleId })
	}
	for (const contributor of added) {
		recordContributor(ctx, 'added', targetId, contributor, actor)
		DB.afterCommit(ctx, () => invalidateContributor(contributor))
	}
}

export const orpcRouter = {
	// every change as a summary. A client caches what it fetched and refetches what a change touches.
	watchChanges: orpcBase.meta({ logLevel: 'trace' }).handler(async function* ({ signal }) {
		yield* watchChanges(signal)
	}),

	watchRotation: orpcBase
		.meta({ logLevel: 'trace' })
		.input(z.object({ rotationId: ROT.RotationIdSchema }))
		.handler(async function* ({ context, signal, input }) {
			yield* watchRotation({ ctx: context, signal }, input.rotationId)
		}),

	search: orpcBase.input(ROT.SearchInputSchema).handler(async ({ input, context: ctx }) => {
		const page = searchSummaries(ctx, input)
		return {
			...page,
			parts: {
				users: await usersOf(
					ctx,
					page.rotations.map((r) => r.owner),
				),
			},
		}
	}),

	getFacets: orpcBase.handler(async ({ context: ctx }) => {
		const facets = getFacets(ctx)
		return { ...facets, parts: { users: await usersOf(ctx, facets.owners) } }
	}),

	get: orpcBase.input(ROT.RotationIdSchema).handler(async ({ input, context: ctx }) => {
		const rotation = getRotation(ctx, input) ?? null
		return { rotation, parts: { users: await usersOf(ctx, rotation ? [rotation.owner] : []) } }
	}),

	// the names of the rotations that exist among `ids`
	getNames: orpcBase.input(z.array(ROT.RotationIdSchema).max(MAX_NAME_LOOKUPS)).handler(({ input, context: ctx }) => {
		if (input.length === 0) return {}
		const rows = DB.all(ctx, Q.rotationNames({ ids: input }))
		return Object.fromEntries(rows.map((r) => [r.id, r.name])) as Record<ROT.RotationId, string>
	}),

	// the first of `<sourceId>-copy`, `<sourceId>-copy-2`, ... that no rotation has
	suggestCloneId: orpcBase.input(ROT.RotationIdSchema).handler(({ input, context: ctx }) => {
		const base = F.cloneId(new Set(), input)
		const needle = `${base.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}-%`
		const rows = DB.all(ctx, Q.cloneIdsTaken({ base, needle }))
		return F.cloneId(new Set(rows.map((r) => r.id)), input)
	}),

	create: orpcBase
		.meta({ type: 'mutation' })
		.input(ROT.NewRotationSchema)
		.handler(async ({ input, context: ctx }) => {
			const actor = { type: 'slm-user' as const, userId: ctx.user.discordId }
			return createRotation(ctx, { ...input, owner: actor }, actor)
		}),

	clone: orpcBase
		.meta({ type: 'mutation' })
		.input(ROT.CloneInputSchema)
		.handler(async ({ input, context: ctx }) => {
			const actor = { type: 'slm-user' as const, userId: ctx.user.discordId }
			return cloneRotation(ctx, input, actor, actor)
		}),

	updateMeta: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ rotationId: ROT.RotationIdSchema, patch: ROT.MetaPatchSchema }))
		.handler(({ input, context: ctx }) => {
			return updateRotation(ctx, input.rotationId, input.patch, { type: 'slm-user', userId: ctx.user.discordId })
		}),

	delete: orpcBase
		.meta({ type: 'mutation' })
		.input(ROT.RotationIdSchema)
		.handler(async ({ input, context: ctx }) => deleteRotation(ctx, input, { type: 'slm-user', userId: ctx.user.discordId })),

	// users and roles are read separately: joining both onto the rotation crosses them
	getContributors: orpcBase.input(ROT.RotationIdSchema).handler(async ({ input, context: ctx }) => {
		const userRows = DB.all(ctx, Q.contributingUsers({ rotationId: input }))
		const roleRows = DB.all(ctx, Q.roleContributorIds({ rotationId: input }))
		return { users: await Users.buildUsers(userRows), roles: roleRows.map((row) => row.roleId) }
	}),

	addContributor: orpcBase
		.meta({ type: 'mutation' })
		.input(ToggleContributorInputSchema)
		.handler(async ({ input, context: ctx }) => {
			const denyRes = await denyUnlessOwner(ctx, input.rotationId)
			if (denyRes) return denyRes
			return addContributor(ctx, input.rotationId, toContributor(input), { type: 'slm-user', userId: ctx.user.discordId })
		}),

	removeContributor: orpcBase
		.meta({ type: 'mutation' })
		.input(ToggleContributorInputSchema)
		.handler(async ({ input, context: ctx }) => {
			const denyRes = await denyUnlessOwner(ctx, input.rotationId)
			if (denyRes) return denyRes
			return removeContributor(ctx, input.rotationId, toContributor(input), { type: 'slm-user', userId: ctx.user.discordId })
		}),
}

// `subscribed` comes first on every (re)subscription: the client missed any change made while it was away
export type RotationChange = { code: 'subscribed' } | { code: 'mutation'; mutation: ROT.SummaryMutation & { actor: AppEvents.Actor } }

export async function* watchChanges(signal?: AbortSignal): AsyncGenerator<RotationChange & Partial<Parts<USR.UserPart>>, void, unknown> {
	yield { code: 'subscribed' as const }
	yield* Rx.Ext.toAsyncGenerator(summaryMutation$.pipe(Rx.Ext.withAbortSignal(signal!)))
}

// the users a mutation names, built once for every watcher rather than once per watcher
const mutationUsers$ = rotationMutation$.pipe(
	Rx.concatMap(async ([ctx, mutation]) => {
		const actorIds = mutation.actor.type === 'slm-user' ? [mutation.actor.userId] : []
		return { mutation, users: await usersOf(ctx, [mutation.value.owner], actorIds) }
	}),
	Rx.share(),
)

const summaryMutation$ = mutationUsers$.pipe(
	Rx.map(({ mutation, users }) => ({
		code: 'mutation' as const,
		mutation: { type: mutation.type, key: mutation.key, value: ROT.toSummary(mutation.value), actor: mutation.actor },
		parts: { users },
	})),
	Rx.share(),
)

// the rotation in full, then again on every change to it; null while it does not exist
export async function* watchRotation(
	{ ctx, signal }: { ctx: C.Db; signal?: AbortSignal },
	rotationId: ROT.RotationId,
): AsyncGenerator<{ rotation: ROT.Rotation | null } & Parts<USR.UserPart>, void, unknown> {
	const rotation$ = Rx.defer(() => {
		// a change that lands while the initial read is in flight is newer than what the read returns
		let changed = false
		const changes$ = mutationUsers$.pipe(
			Rx.filter(({ mutation }) => mutation.key === rotationId),
			Rx.tap(() => {
				changed = true
			}),
			Rx.map(({ mutation, users }) => ({ rotation: mutation.type === 'delete' ? null : mutation.value, parts: { users } })),
		)
		const initial$ = Rx.defer(async () => {
			const rotation = getRotation(ctx, rotationId) ?? null
			return { rotation, parts: { users: await usersOf(ctx, rotation ? [rotation.owner] : []) } }
		}).pipe(Rx.filter(() => !changed))
		return Rx.merge(changes$, initial$)
	})
	yield* Rx.Ext.toAsyncGenerator(rotation$.pipe(Rx.Ext.withAbortSignal(signal!)))
}

export function setup() {
	log = module.getLogger()
	Settings.registerRepeatRulesetUsers((ctx) => DB.all(ctx, Q.repeatRulesetIdsInUse({})).flatMap((r) => r.repeatRulesetId ?? []))
}
