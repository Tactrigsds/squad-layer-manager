import * as E from 'drizzle-orm'

import * as Schema from '$root/drizzle/schema.ts'
import * as Paths from '$root/paths.ts'
import { z } from '@/lib/zod'
import * as CL from '@/models/changelog.models'
import type * as C from '@/server/context'
import * as DB from '@/server/db'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as ChangelogFiles from '@/systems/changelog-files.server'

// The in-app changelog. At boot it reads the fragments this build ships, records when this install first ran each
// one, and logs the operator notes for everything that arrived with this boot. The releases are fixed for the life
// of the process, so they are served from memory.

const module = initModule('changelog')
const orpcBase = getOrpcBase(module)

export let version = CL.runningVersion(null, 0)
let releases: CL.ServedRelease[] = []

export async function setup(ctx: C.Db) {
	const log = module.getLogger()
	const loaded = ChangelogFiles.load(Paths.CHANGELOG, Paths.CHANGES)
	for (const err of loaded.errors) log.warn('changelog: %s', err)
	version = CL.runningVersion(loaded.index[0]?.version ?? null, loaded.pending.length)

	const now = Date.now()
	const servedAt = await DB.runTransaction(ctx, async (ctx) => {
		const rows = await ctx.db().select().from(Schema.changelogEntries)
		const known = new Map(rows.map((row) => [row.entryId, row.firstServedAt.getTime()]))
		// an install's first boot with a changelog: everything it ships is history, not news
		const stampedAt = rows.length === 0 ? 0 : now
		const arrived = loaded.releases.flatMap((r) => r.entries).filter((e) => !known.has(e.id))
		if (arrived.length > 0) {
			await ctx
				.db()
				.insert(Schema.changelogEntries)
				.values(arrived.map((e) => ({ entryId: e.id, firstServedAt: new Date(stampedAt) })))
				.onConflictDoNothing()
			for (const e of arrived) known.set(e.id, stampedAt)
		}
		return known
	})

	releases = loaded.releases.map((release) => ({
		...release,
		entries: release.entries.map((entry) => ({ ...entry, firstServedAt: servedAt.get(entry.id) ?? 0 })),
	}))

	log.info('running version %s', version)
	for (const release of releases) {
		for (const entry of release.entries) {
			if (entry.firstServedAt !== now || entry.audience !== 'operators') continue
			const where = release.version ?? 'unreleased'
			if (entry.kind === 'breaking') log.warn('upgrade note (%s, breaking): %s', where, entry.title)
			else log.info('upgrade note (%s): %s', where, entry.title)
		}
	}
}

// the caller's place in the changelog, created on first read as having seen everything so far, so a new user does
// not start with the install's whole history marked unread
async function readUserState(ctx: C.Db, userId: bigint): Promise<CL.UserState> {
	const [existing] = await ctx.db().select().from(Schema.changelogUserState).where(E.eq(Schema.changelogUserState.userId, userId))
	const row =
		existing ??
		(
			await ctx
				.db()
				.insert(Schema.changelogUserState)
				.values({ userId, seenAt: new Date(CL.latestServedAt(releases)) })
				.onConflictDoUpdate({ target: Schema.changelogUserState.userId, set: { userId } })
				.returning()
		)[0]
	return { seenAt: row.seenAt.getTime(), notify: row.notify }
}

export const orpcRouter = {
	// the caller's own state alongside the releases, which are public: nothing to check
	get: orpcBase.handler(async ({ context }) => {
		const state = await readUserState(context, context.user.discordId)
		return { version, releases, ...state }
	}),

	getStatus: orpcBase.meta({ logLevel: 'trace' }).handler(async ({ context }) => {
		const state = await readUserState(context, context.user.discordId)
		return { version, notify: state.notify, unseen: CL.countUnseen(releases, state.seenAt) }
	}),

	// `upTo` is the newest entry the page showed rather than the time of the call, so an entry that arrives while the
	// page is open stays unseen
	markSeen: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ upTo: z.number().int().nonnegative() }))
		.handler(async ({ context, input }) => {
			await readUserState(context, context.user.discordId)
			const seenAt = new Date(Math.min(input.upTo, Date.now()))
			await context
				.db()
				.update(Schema.changelogUserState)
				.set({ seenAt })
				.where(E.and(E.eq(Schema.changelogUserState.userId, context.user.discordId), E.lt(Schema.changelogUserState.seenAt, seenAt)))
			return { code: 'ok' as const }
		}),

	setNotify: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ notify: z.boolean() }))
		.handler(async ({ context, input }) => {
			await readUserState(context, context.user.discordId)
			await context
				.db()
				.update(Schema.changelogUserState)
				.set({ notify: input.notify })
				.where(E.eq(Schema.changelogUserState.userId, context.user.discordId))
			return { code: 'ok' as const }
		}),
}
