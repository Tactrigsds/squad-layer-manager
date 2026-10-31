import * as E from 'drizzle-orm'

import * as Schema from '$root/drizzle/schema.ts'
import * as Paths from '$root/paths.ts'
import { z } from '@/lib/zod'
import * as CL from '@/models/changelog.models'
import type * as C from '@/server/context'
import * as DB from '@/server/db'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as Sql from '@/server/sql'
import * as ChangelogFiles from '@/systems/changelog-files.server'

// The in-app changelog. At boot it reads the fragments this build ships, records when this install first ran each
// one, and logs the operator notes for everything that arrived with this boot. The releases are fixed for the life
// of the process, so they are served from memory.

const module = initModule('changelog')
const orpcBase = getOrpcBase(module)
const SQL = Sql.forModule(module)

export let version = CL.runningVersion(null, 0)
let releases: CL.ServedRelease[] = []

const allEntries = SQL.def('allEntries', SQL.params({}), SQL.select().from(Schema.changelogEntries), { scans: ['changelogEntries'] })
const entryP = SQL.params({ entryId: Schema.changelogEntries.entryId, firstServedAt: Schema.changelogEntries.firstServedAt })
const insertEntry = SQL.def(
	'insertEntry',
	entryP,
	SQL.insert(Schema.changelogEntries).values({ entryId: entryP.entryId, firstServedAt: entryP.firstServedAt }).onConflictDoNothing(),
)

export function setup(ctx: C.Db) {
	const log = module.getLogger()
	const loaded = ChangelogFiles.load(Paths.CHANGELOG, Paths.CHANGES)
	for (const err of loaded.errors) log.warn('changelog: %s', err)
	version = CL.runningVersion(loaded.index[0]?.version ?? null, loaded.pending.length)

	const now = Date.now()
	const { known: servedAt } = DB.transaction(ctx, {}, (ctx) => {
		const rows = DB.all(ctx, allEntries({}))
		const known = new Map(rows.map((row) => [row.entryId, row.firstServedAt.getTime()]))
		// an install's first boot with a changelog: everything it ships is history, not news
		const stampedAt = rows.length === 0 ? 0 : now
		const arrived = loaded.releases.flatMap((r) => r.entries).filter((e) => !known.has(e.id))
		for (const e of arrived) {
			DB.run(ctx, insertEntry({ entryId: e.id, firstServedAt: new Date(stampedAt) }))
			known.set(e.id, stampedAt)
		}
		return { code: 'ok' as const, known }
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

const userIdP = SQL.params({ userId: Schema.changelogUserState.userId })
const userState = SQL.def(
	'userState',
	userIdP,
	SQL.select().from(Schema.changelogUserState).where(E.eq(Schema.changelogUserState.userId, userIdP.userId)),
)
const newUserStateP = SQL.params({ userId: Schema.changelogUserState.userId, seenAt: Schema.changelogUserState.seenAt })
const insertUserState = SQL.def(
	'insertUserState',
	newUserStateP,
	SQL.insert(Schema.changelogUserState)
		.values({ userId: newUserStateP.userId, seenAt: newUserStateP.seenAt })
		.onConflictDoUpdate({ target: Schema.changelogUserState.userId, set: { userId: newUserStateP.userId } })
		.returning(),
)
const markSeenP = SQL.params({ userId: Schema.changelogUserState.userId, seenAt: Schema.changelogUserState.seenAt })
const markSeenUpTo = SQL.def(
	'markSeenUpTo',
	markSeenP,
	SQL.update(Schema.changelogUserState)
		.set({ seenAt: markSeenP.seenAt })
		.where(E.and(E.eq(Schema.changelogUserState.userId, markSeenP.userId), E.lt(Schema.changelogUserState.seenAt, markSeenP.seenAt))),
)
const prefsP = SQL.params({
	userId: Schema.changelogUserState.userId,
	notifyLevel: Schema.changelogUserState.notifyLevel,
	showOperatorNotes: Schema.changelogUserState.showOperatorNotes,
})
const setUserPrefs = SQL.def(
	'setUserPrefs',
	prefsP,
	SQL.update(Schema.changelogUserState)
		.set({ notifyLevel: prefsP.notifyLevel, showOperatorNotes: prefsP.showOperatorNotes })
		.where(E.eq(Schema.changelogUserState.userId, prefsP.userId)),
)

// the caller's place in the changelog, created on first read as having seen everything so far, so a new user does
// not start with the install's whole history marked unread
function readUserState(ctx: C.Db, userId: bigint): CL.UserState {
	const row =
		DB.get(ctx, userState({ userId })) ?? DB.get(ctx, insertUserState({ userId, seenAt: new Date(CL.latestServedAt(releases)) }))!
	return { seenAt: row.seenAt.getTime(), notifyLevel: row.notifyLevel, showOperatorNotes: row.showOperatorNotes }
}

export const orpcRouter = {
	// the caller's own state alongside the releases, which are public: nothing to check
	get: orpcBase.handler(({ context }) => {
		const state = readUserState(context, context.user.discordId)
		return { version, releases, ...state }
	}),

	getStatus: orpcBase.meta({ logLevel: 'trace' }).handler(({ context }) => {
		const state = readUserState(context, context.user.discordId)
		return { version, unseen: CL.countUnseen(releases, state) }
	}),

	// `upTo` is the newest entry the page showed rather than the time of the call, so an entry that arrives while the
	// page is open stays unseen
	markSeen: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ upTo: z.number().int().nonnegative() }))
		.handler(({ context, input }) => {
			readUserState(context, context.user.discordId)
			const seenAt = new Date(Math.min(input.upTo, Date.now()))
			DB.run(context, markSeenUpTo({ userId: context.user.discordId, seenAt }))
			return { code: 'ok' as const }
		}),

	setPrefs: orpcBase
		.meta({ type: 'mutation' })
		.input(CL.PrefsSchema.partial().refine((p) => Object.keys(p).length > 0, { message: 'nothing to set' }))
		.handler(({ context, input }) => {
			const userId = context.user.discordId
			const state = readUserState(context, userId)
			DB.run(
				context,
				setUserPrefs({
					userId,
					notifyLevel: input.notifyLevel ?? state.notifyLevel,
					showOperatorNotes: input.showOperatorNotes ?? state.showOperatorNotes,
				}),
			)
			return { code: 'ok' as const }
		}),
}
