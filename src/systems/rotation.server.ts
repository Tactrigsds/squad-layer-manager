// Rotations: their rows, who may edit them, and the live set every client watches. The shared draft of one rotation's
// items is in rotation-edit.server.ts, which writes here when a draft is saved.
import * as E from 'drizzle-orm'

import * as Schema from '$root/drizzle/schema.ts'
import { returnInsertErrors, superjsonify, unsuperjsonify } from '@/lib/drizzle'
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
import * as AppEventsSys from '@/systems/app-events.server'
import * as CleanupSys from '@/systems/cleanup.server'
import * as Rbac from '@/systems/rbac.server'
import * as Settings from '@/systems/settings.server'
import * as Users from '@/systems/users.server'

const module = initModule('rotation')
let log!: CS.Logger
const orpcBase = getOrpcBase(module)

export const rotationMutation$ = new IsolatedSubject<[C.Db & CS.Otel, ROT.Mutation & { actor: AppEvents.Actor }]>()

export let state!: {
	rotations: Map<ROT.RotationId, ROT.Rotation>
}

const ToggleContributorInputSchema = z
	.object({ rotationId: ROT.RotationIdSchema, userId: z.bigint().optional(), roleId: RBAC.UserDefinedRoleIdSchema.optional() })
	.refine((input) => input.userId || input.roleId, { error: 'Either userId or role must be provided' })
type ToggleContributorInput = z.infer<typeof ToggleContributorInputSchema>

async function recordChange(
	ctx: C.Db,
	actor: AppEvents.Actor,
	action: AppEvents.RotationChanged['action'],
	rotation: ROT.Rotation,
	details?: { changedFields?: string[]; clonedFrom?: ROT.RotationId },
) {
	await AppEventsSys.persistAppEvent(
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

async function recordContributor(
	ctx: C.Db & USR.Ctx.Id,
	action: AppEvents.RotationContributorChanged['action'],
	input: ToggleContributorInput,
) {
	await AppEventsSys.persistAppEvent(
		ctx,
		AppEvents.create<AppEvents.RotationContributorChanged>({
			type: 'ROTATION_CONTRIBUTOR_CHANGED',
			action,
			rotationId: input.rotationId,
			rotationName: state.rotations.get(input.rotationId)?.name,
			contributor: input.userId !== undefined ? { type: 'user', userId: input.userId } : { type: 'role', roleId: input.roleId! },
			actor: { type: 'slm-user', userId: ctx.user.discordId },
			serverId: null,
			matchId: null,
			causeId: null,
		}),
	)
}

function emit(ctx: C.Db, mutation: ROT.Mutation, actor: AppEvents.Actor) {
	rotationMutation$.next([CS.storeLinkToActiveSpan(ctx, 'event.emitter'), { ...mutation, actor }])
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
	const rotation = state.rotations.get(rotationId)
	if (rotation && F.ownerUserId(rotation.owner) === ctx.user.discordId) return null
	return Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('rotations:write-all'))
}

// The write paths below take no permission check, which stays with the rpc handlers: the editing session and plugins
// write a rotation the same way a person does.

export async function createRotation(
	ctx: C.Db & CS.AbortSignal,
	input: ROT.NewRotation & { owner: ROT.Owner },
	actor: AppEvents.Actor,
	opts?: { clonedFrom?: ROT.RotationId },
) {
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
	const res = await returnInsertErrors(
		ctx
			.db()
			.insert(Schema.rotations)
			.values(superjsonify(Schema.rotations, ROT.toRow(rotation))),
	)
	if (res.code !== 'ok') return { code: res.code }
	emit(ctx, { type: 'add', key: rotation.id, value: rotation }, actor)
	await recordChange(ctx, actor, 'created', rotation, { clonedFrom: opts?.clonedFrom })
	const ownerUserId = F.ownerUserId(rotation.owner)
	if (ownerUserId !== null) Rbac.invalidateUser(ownerUserId)
	log.info('created rotation %s', rotation.id)
	return { code: 'ok' as const, rotation }
}

export async function updateRotation(ctx: C.Db & CS.AbortSignal, id: ROT.RotationId, patch: ROT.UpdatePatch, actor: AppEvents.Actor) {
	const prev = state.rotations.get(id)
	if (!prev) return { code: 'err:not-found' as const }
	const repeatRulesetError = unknownRepeatRulesetError(patch.repeatRulesetId)
	if (repeatRulesetError) return repeatRulesetError
	const tagsError = unknownTagsError(patch.tags)
	if (tagsError) return tagsError
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
	const { id: _id, ...row } = ROT.toRow(next)
	await ctx.db().update(Schema.rotations).set(superjsonify(Schema.rotations, row)).where(E.eq(Schema.rotations.id, id))
	emit(ctx, { type: 'update', key: id, value: next }, actor)
	await recordChange(ctx, actor, 'updated', next, { changedFields })
	return { code: 'ok' as const, rotation: next }
}

export async function deleteRotation(ctx: C.Db & CS.AbortSignal, id: ROT.RotationId, actor: AppEvents.Actor) {
	const res = await DB.runTransaction(ctx, async (ctx) => {
		const rotation = state.rotations.get(id)
		if (!rotation) return { code: 'err:not-found' as const }
		// captured before the delete so the affected inferred-role holders can be invalidated after commit
		const userContributors = await ctx
			.db()
			.select({ userId: Schema.rotationUserContributors.userId })
			.from(Schema.rotationUserContributors)
			.where(E.eq(Schema.rotationUserContributors.rotationId, id))
		const [roleContributor] = await ctx
			.db()
			.select({ roleId: Schema.rotationRoleContributors.roleId })
			.from(Schema.rotationRoleContributors)
			.where(E.eq(Schema.rotationRoleContributors.rotationId, id))
			.limit(1)
		await ctx.db().delete(Schema.rotations).where(E.eq(Schema.rotations.id, id))
		return {
			code: 'ok' as const,
			rotation,
			userContributorIds: userContributors.map((r) => r.userId),
			hasRoleContributors: !!roleContributor,
		}
	})
	if (res.code !== 'ok') return res
	if (res.hasRoleContributors) Rbac.invalidateAll()
	else {
		const ownerUserId = F.ownerUserId(res.rotation.owner)
		if (ownerUserId !== null) Rbac.invalidateUser(ownerUserId)
		for (const userId of res.userContributorIds) Rbac.invalidateUser(userId)
	}
	emit(ctx, { type: 'delete', key: id, value: res.rotation }, actor)
	await recordChange(ctx, actor, 'deleted', res.rotation)
	return { code: 'ok' as const }
}

export async function cloneRotation(ctx: C.Db & CS.AbortSignal, input: ROT.CloneInput, owner: ROT.Owner, actor: AppEvents.Actor) {
	const source = state.rotations.get(input.sourceId)
	if (!source) return { code: 'err:not-found' as const }
	const res = await createRotation(
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
	const [users, roles] = await Promise.all([
		ctx.db().select().from(Schema.rotationUserContributors).where(E.eq(Schema.rotationUserContributors.rotationId, source.id)),
		ctx.db().select().from(Schema.rotationRoleContributors).where(E.eq(Schema.rotationRoleContributors.rotationId, source.id)),
	])
	if (users.length > 0) {
		await ctx
			.db()
			.insert(Schema.rotationUserContributors)
			.values(users.map((u) => ({ rotationId: input.id, userId: u.userId })))
	}
	if (roles.length > 0) {
		await ctx
			.db()
			.insert(Schema.rotationRoleContributors)
			.values(roles.map((r) => ({ rotationId: input.id, roleId: r.roleId })))
		Rbac.invalidateAll()
	} else {
		for (const u of users) Rbac.invalidateUser(u.userId)
	}
	return res
}

export const orpcRouter = {
	watchRotations: orpcBase.meta({ logLevel: 'trace' }).handler(async function* ({ context, signal }) {
		yield* watchRotations({ ctx: context, signal })
	}),

	create: orpcBase
		.meta({ type: 'mutation' })
		.input(ROT.NewRotationSchema)
		.handler(async ({ input, context: ctx }) => {
			const actor = { type: 'slm-user' as const, userId: ctx.user.discordId }
			return await createRotation(ctx, { ...input, owner: actor }, actor)
		}),

	clone: orpcBase
		.meta({ type: 'mutation' })
		.input(ROT.CloneInputSchema)
		.handler(async ({ input, context: ctx }) => {
			const actor = { type: 'slm-user' as const, userId: ctx.user.discordId }
			return await cloneRotation(ctx, input, actor, actor)
		}),

	updateMeta: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ rotationId: ROT.RotationIdSchema, patch: ROT.MetaPatchSchema }))
		.handler(async ({ input, context: ctx }) => {
			return await updateRotation(ctx, input.rotationId, input.patch, { type: 'slm-user', userId: ctx.user.discordId })
		}),

	delete: orpcBase
		.meta({ type: 'mutation' })
		.input(ROT.RotationIdSchema)
		.handler(async ({ input, context: ctx }) => deleteRotation(ctx, input, { type: 'slm-user', userId: ctx.user.discordId })),

	// users and roles are read separately: joining both onto the rotation crosses them
	getContributors: orpcBase.input(ROT.RotationIdSchema).handler(async ({ input, context: ctx }) => {
		const contributingUserIds = ctx
			.db()
			.select({ userId: Schema.rotationUserContributors.userId })
			.from(Schema.rotationUserContributors)
			.where(E.eq(Schema.rotationUserContributors.rotationId, input))
		const userRows = await Users.selectUsers(ctx).where(E.inArray(Schema.users.discordId, contributingUserIds))
		const roleRows = await ctx
			.db()
			.select({ roleId: Schema.rotationRoleContributors.roleId })
			.from(Schema.rotationRoleContributors)
			.where(E.eq(Schema.rotationRoleContributors.rotationId, input))
		return { users: await Users.buildUsers(userRows), roles: roleRows.map((row) => row.roleId) }
	}),

	addContributor: orpcBase
		.meta({ type: 'mutation' })
		.input(ToggleContributorInputSchema)
		.handler(async ({ input, context: ctx }) => {
			const denyRes = await denyUnlessOwner(ctx, input.rotationId)
			if (denyRes) return denyRes
			const res = input.userId
				? await returnInsertErrors(
						ctx.db().insert(Schema.rotationUserContributors).values({ rotationId: input.rotationId, userId: input.userId }),
					)
				: await returnInsertErrors(
						ctx.db().insert(Schema.rotationRoleContributors).values({ rotationId: input.rotationId, roleId: input.roleId! }),
					)
			switch (res.code) {
				case 'err:already-exists':
					return { code: 'err:already-exists' as const }
				case 'ok':
					await recordContributor(ctx, 'added', input)
					if (input.userId) Rbac.invalidateUser(input.userId)
					else Rbac.invalidateAll()
					return { code: 'ok' as const }
				default:
					assertNever(res)
			}
		}),

	removeContributor: orpcBase
		.meta({ type: 'mutation' })
		.input(ToggleContributorInputSchema)
		.handler(async ({ input, context: ctx }) => {
			const denyRes = await denyUnlessOwner(ctx, input.rotationId)
			if (denyRes) return denyRes
			const resultSet = input.userId
				? await ctx
						.db()
						.delete(Schema.rotationUserContributors)
						.where(
							E.and(
								E.eq(Schema.rotationUserContributors.rotationId, input.rotationId),
								E.eq(Schema.rotationUserContributors.userId, input.userId),
							),
						)
				: await ctx
						.db()
						.delete(Schema.rotationRoleContributors)
						.where(
							E.and(
								E.eq(Schema.rotationRoleContributors.rotationId, input.rotationId),
								E.eq(Schema.rotationRoleContributors.roleId, input.roleId!),
							),
						)
			if (resultSet.changes === 0) return { code: 'err:not-found' as const }
			await recordContributor(ctx, 'removed', input)
			if (input.userId) Rbac.invalidateUser(input.userId)
			else Rbac.invalidateAll()
			return { code: 'ok' as const }
		}),
}

export type RotationChange =
	| { code: 'initial-value'; rotations: ROT.Rotation[] }
	| { code: 'mutation'; mutation: ROT.Mutation & { actor: AppEvents.Actor } }

export async function* watchRotations({
	ctx,
	signal,
}: {
	ctx: C.Db
	signal?: AbortSignal
}): AsyncGenerator<RotationChange & Parts<USR.UserPart>, void, unknown> {
	const ids = [...new Set(Array.from(state.rotations.values()).flatMap((r) => F.ownerUserId(r.owner) ?? []))]
	const dbUsers = ids.length > 0 ? await Users.selectUsers(ctx).where(E.inArray(Schema.users.discordId, ids)) : []
	yield {
		code: 'initial-value' as const,
		rotations: Array.from(state.rotations.values()),
		parts: { users: await Users.buildUsers(dbUsers) },
	}
	yield* Rx.Ext.toAsyncGenerator(mutationWithParts$.pipe(Rx.Ext.withAbortSignal(signal!)))
}

// the users a mutation names, built once for every watcher rather than once per watcher
const mutationWithParts$ = rotationMutation$.pipe(
	Rx.concatMap(async ([ctx, mutation]) => {
		const userIds = new Set<bigint>()
		const ownerUserId = F.ownerUserId(mutation.value.owner)
		if (ownerUserId !== null) userIds.add(ownerUserId)
		if (mutation.actor.type === 'slm-user') userIds.add(mutation.actor.userId)
		const dbUsers = userIds.size > 0 ? await Users.selectUsers(ctx).where(E.inArray(Schema.users.discordId, [...userIds])) : []
		return { code: 'mutation' as const, mutation, parts: { users: await Users.buildUsers(dbUsers) } }
	}),
	Rx.share(),
)

export async function setup() {
	log = module.getLogger()
	const ctx = DB.addPooledDb({ ...CS.init(), signal: CleanupSys.shutdownSignal })
	const rows = await ctx.db().select().from(Schema.rotations)
	state = {
		rotations: new Map(rows.map((row) => ROT.fromRow(unsuperjsonify(Schema.rotations, row))).map((r) => [r.id, r])),
	}
	Settings.registerRepeatRulesetUsers(() => Array.from(state.rotations.values()).flatMap((r) => r.repeatRulesetId ?? []))

	rotationMutation$.subscribe(([, mutation]) => {
		switch (mutation.type) {
			case 'add':
			case 'update':
				state.rotations.set(mutation.key, mutation.value)
				break
			case 'delete':
				state.rotations.delete(mutation.key)
				break
			default:
				assertNever(mutation.type)
		}
	})
}
