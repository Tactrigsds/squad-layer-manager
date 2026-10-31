import * as E from 'drizzle-orm'
import * as Crypto from 'node:crypto'

import * as Schema from '$root/drizzle/schema.ts'
import { IsolatedSubject } from '@/lib/isolated-subject'
import * as Rx from '@/lib/rxjs'
import { z } from '@/lib/zod'
import * as ZodUtils from '@/lib/zod-utils'
import * as AppEvents from '@/models/app-events.models'
import type * as CS from '@/models/context-shared.models'
import type * as SM from '@/models/squad.models'
import * as USR from '@/models/users.models'
import type * as RBAC from '@/rbac.models'
import type * as C from '@/server/context'
import * as DB from '@/server/db'
import * as Env from '@/server/env'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as Sql from '@/server/sql'
import * as AppEventsSys from '@/systems/app-events.server'
import * as Discord from '@/systems/discord.server'
import * as PlayerDiscordRoles from '@/systems/player-discord-roles.server'
import * as Rbac from '@/systems/rbac.server'

// discordId set = only that user's session(s) should refetch (their perms/links changed); undefined = broadcast to
// every session (user metadata like a nickname that others render). rbac invalidation is bridged in via setup().
const invalidateUsers$ = new IsolatedSubject<{ discordId?: bigint }>()
const ROLE_DISPLAY_THROTTLE_MS = 1000

const module = initModule('users')
let log!: CS.Logger
const orpcBase = getOrpcBase(module)
const SQL = Sql.forModule(module)

const envBuilder = Env.getEnvBuilder({ ...Env.groups.discord })
let ENV!: ReturnType<typeof envBuilder>

export function setup() {
	log = module.getLogger()
	ENV = envBuilder()
	// reuse this channel to push rbac perm changes to clients: 'user' scope targets the one session, 'all' broadcasts
	Rbac.invalidation$.subscribe((e) => invalidateUsers$.next(e.scope === 'user' ? { discordId: e.discordId } : {}))
	// a role reorder arrives as one update per role moved
	Discord.roleDisplayChanged$
		.pipe(Rx.throttleTime(ROLE_DISPLAY_THROTTLE_MS, Rx.asyncScheduler, { leading: true, trailing: true }))
		.subscribe(() => invalidateUsers$.next({}))
}

// A user's profile lives on their discord account, so every read of one is this join. Selected explicitly rather
// than as two nested objects, because buildUser wants the flat row.
export const userColumns = {
	discordId: Schema.users.discordId,
	nickname: Schema.users.nickname,
	username: Schema.discordAccounts.username,
}
const isConnectionLinkOf = (discordId: typeof Q.linkOwnerIdP.discordId) =>
	E.and(
		E.eq(Schema.linkedSteamAccounts.discordId, discordId),
		E.eq(Schema.linkedSteamAccounts.origin, SQL.lit('discord-connection' as const)),
	)

const linkColumns = {
	steam64Id: Schema.linkedSteamAccounts.steam64Id,
	discordId: Schema.linkedSteamAccounts.discordId,
	origin: Schema.linkedSteamAccounts.origin,
	linkedBy: Schema.linkedSteamAccounts.linkedBy,
	createdAt: Schema.linkedSteamAccounts.createdAt,
	username: Schema.discordAccounts.username,
}

namespace Q {
	const userIdP = SQL.params({ id: Schema.users.discordId })
	export const userById = SQL.def(
		'userById',
		userIdP,
		SQL.select(userColumns)
			.from(Schema.users)
			.innerJoin(Schema.discordAccounts, E.eq(Schema.users.discordId, Schema.discordAccounts.discordId))
			.where(E.eq(Schema.users.discordId, userIdP.id)),
	)
	const userIdsP = SQL.params({ ids: SQL.list(Schema.users.discordId) })
	export const usersByIds = SQL.def(
		'usersByIds',
		userIdsP,
		SQL.select(userColumns)
			.from(Schema.users)
			.innerJoin(Schema.discordAccounts, E.eq(Schema.users.discordId, Schema.discordAccounts.discordId))
			.where(SQL.inJson(Schema.users.discordId, userIdsP.ids)),
	)
	export const allUsers = SQL.def(
		'allUsers',
		SQL.params({}),
		SQL.select(userColumns)
			.from(Schema.users)
			.innerJoin(Schema.discordAccounts, E.eq(Schema.users.discordId, Schema.discordAccounts.discordId)),
		{ scans: ['users'] },
	)
	export const userRow = SQL.def('userRow', userIdP, SQL.select().from(Schema.users).where(E.eq(Schema.users.discordId, userIdP.id)))
	const setNicknameP = SQL.params({ id: Schema.users.discordId, nickname: Schema.users.nickname })
	export const setNickname = SQL.def(
		'setNickname',
		setNicknameP,
		SQL.update(Schema.users).set({ nickname: setNicknameP.nickname }).where(E.eq(Schema.users.discordId, setNicknameP.id)),
	)
	const discordAccountP = SQL.params({
		discordId: Schema.discordAccounts.discordId,
		username: Schema.discordAccounts.username,
		now: Schema.discordAccounts.updatedAt,
	})
	export const upsertDiscordAccount = SQL.def(
		'upsertDiscordAccount',
		discordAccountP,
		SQL.insert(Schema.discordAccounts)
			.values({ discordId: discordAccountP.discordId, username: discordAccountP.username, updatedAt: discordAccountP.now })
			.onConflictDoUpdate({
				target: Schema.discordAccounts.discordId,
				set: { username: E.sql`excluded.username`, updatedAt: E.sql`excluded.updatedAt` },
			}),
	)
	const steamIdP = SQL.params({ steam64Id: Schema.linkedSteamAccounts.steam64Id })
	export const linkOwner = SQL.def(
		'linkOwner',
		steamIdP,
		SQL.select({ discordId: Schema.linkedSteamAccounts.discordId })
			.from(Schema.linkedSteamAccounts)
			.where(E.eq(Schema.linkedSteamAccounts.steam64Id, steamIdP.steam64Id)),
	)
	const steamIdsP = SQL.params({ ids: SQL.list(Schema.linkedSteamAccounts.steam64Id) })
	export const linkOwners = SQL.def(
		'linkOwners',
		steamIdsP,
		SQL.select({ steam64Id: Schema.linkedSteamAccounts.steam64Id, discordId: Schema.linkedSteamAccounts.discordId })
			.from(Schema.linkedSteamAccounts)
			.where(SQL.inJson(Schema.linkedSteamAccounts.steam64Id, steamIdsP.ids)),
	)
	export const linkOwnerIdP = SQL.params({ discordId: Schema.linkedSteamAccounts.discordId })
	export const linkedSteamIds = SQL.def(
		'linkedSteamIds',
		linkOwnerIdP,
		SQL.select({ steam64Id: Schema.linkedSteamAccounts.steam64Id })
			.from(Schema.linkedSteamAccounts)
			.where(E.eq(Schema.linkedSteamAccounts.discordId, linkOwnerIdP.discordId)),
	)
	export const connectionLinkedSteamIds = SQL.def(
		'connectionLinkedSteamIds',
		linkOwnerIdP,
		SQL.select({ steam64Id: Schema.linkedSteamAccounts.steam64Id })
			.from(Schema.linkedSteamAccounts)
			.where(isConnectionLinkOf(linkOwnerIdP.discordId)),
	)
	const ownLinksP = SQL.params({ discordId: Schema.linkedSteamAccounts.discordId, ids: SQL.list(Schema.linkedSteamAccounts.steam64Id) })
	export const deleteConnectionLinks = SQL.def(
		'deleteConnectionLinks',
		ownLinksP,
		SQL.delete(Schema.linkedSteamAccounts)
			.where(E.and(isConnectionLinkOf(ownLinksP.discordId), SQL.inJson(Schema.linkedSteamAccounts.steam64Id, ownLinksP.ids)))
			.returning({ steam64Id: Schema.linkedSteamAccounts.steam64Id }),
	)
	export const deleteOwnLinks = SQL.def(
		'deleteOwnLinks',
		ownLinksP,
		SQL.delete(Schema.linkedSteamAccounts).where(
			E.and(
				E.eq(Schema.linkedSteamAccounts.discordId, ownLinksP.discordId),
				SQL.inJson(Schema.linkedSteamAccounts.steam64Id, ownLinksP.ids),
			),
		),
	)
	export const deleteLink = SQL.def(
		'deleteLink',
		steamIdP,
		SQL.delete(Schema.linkedSteamAccounts).where(E.eq(Schema.linkedSteamAccounts.steam64Id, steamIdP.steam64Id)),
	)
	const linkP = SQL.params({
		steam64Id: Schema.linkedSteamAccounts.steam64Id,
		discordId: Schema.linkedSteamAccounts.discordId,
		origin: Schema.linkedSteamAccounts.origin,
		linkedBy: Schema.linkedSteamAccounts.linkedBy,
		createdAt: Schema.linkedSteamAccounts.createdAt,
	})
	export const insertLink = SQL.def('insertLink', linkP, SQL.insert(Schema.linkedSteamAccounts).values(linkP))
	export const insertLinkIfFree = SQL.def(
		'insertLinkIfFree',
		linkP,
		SQL.insert(Schema.linkedSteamAccounts)
			.values(linkP)
			.onConflictDoNothing()
			.returning({ steam64Id: Schema.linkedSteamAccounts.steam64Id }),
	)
	export const linksOfDiscordAccount = SQL.def(
		'linksOfDiscordAccount',
		linkOwnerIdP,
		SQL.select(linkColumns)
			.from(Schema.linkedSteamAccounts)
			.innerJoin(Schema.discordAccounts, E.eq(Schema.discordAccounts.discordId, Schema.linkedSteamAccounts.discordId))
			.where(E.eq(Schema.linkedSteamAccounts.discordId, linkOwnerIdP.discordId)),
	)
	export const linkOfSteamAccount = SQL.def(
		'linkOfSteamAccount',
		steamIdP,
		SQL.select(linkColumns)
			.from(Schema.linkedSteamAccounts)
			.innerJoin(Schema.discordAccounts, E.eq(Schema.discordAccounts.discordId, Schema.linkedSteamAccounts.discordId))
			.where(E.eq(Schema.linkedSteamAccounts.steam64Id, steamIdP.steam64Id)),
	)
	export const userBySteamId = SQL.def(
		'userBySteamId',
		steamIdP,
		SQL.select(userColumns)
			.from(Schema.users)
			.innerJoin(Schema.discordAccounts, E.eq(Schema.users.discordId, Schema.discordAccounts.discordId))
			.innerJoin(Schema.linkedSteamAccounts, E.eq(Schema.users.discordId, Schema.linkedSteamAccounts.discordId))
			.where(E.eq(Schema.linkedSteamAccounts.steam64Id, steamIdP.steam64Id)),
	)
	export const userPlayerIds = SQL.def(
		'userPlayerIds',
		linkOwnerIdP,
		SQL.select({ eosid: Schema.players.eosId, steamId: Schema.players.steamId })
			.from(Schema.linkedSteamAccounts)
			.leftJoin(Schema.players, E.eq(Schema.linkedSteamAccounts.steam64Id, Schema.players.steamId))
			.where(E.eq(Schema.linkedSteamAccounts.discordId, linkOwnerIdP.discordId)),
	)
}

export function recordUserAccount(
	ctx: C.Db,
	userId: bigint,
	action: AppEvents.UserAccountChanged['action'],
	details?: Pick<AppEvents.UserAccountChanged, 'steamIds' | 'prevNickname' | 'nickname' | 'subjectDiscordId'>,
) {
	AppEventsSys.persistAppEvent(
		ctx,
		AppEvents.create<AppEvents.UserAccountChanged>({
			type: 'USER_ACCOUNT_CHANGED',
			action,
			...details,
			actor: { type: 'slm-user', userId },
			serverId: null,
			matchId: null,
			causeId: null,
		}),
	)
}

// Claiming a steam account is claiming whatever it is an admin for, so the claim has to be proven rather than
// asserted. The browser mints a code, the player sends it from in game, and the steam id is read off the RCON sender
// instead of typed: the one thing a web session cannot fake is being in the server as that account.
//
// Held in memory, keyed by the code. A restart drops the pending ones, which costs a re-mint and nothing else.
const VERIFICATION_TTL_MS = 5 * 60_000
// No vowels (so a code cannot come out as a word) and no 0/O/1/I, which are the pairs people mistype reading a code
// off one screen and onto another.
const CODE_ALPHABET = '23456789BCDFGHJKMNPQRSTVWXZ'
const CODE_LENGTH = 6
const pendingVerifications = new Map<string, { discordId: bigint; expiresAt: number }>()

function sweepVerifications(now: number) {
	for (const [code, pending] of pendingVerifications) {
		if (pending.expiresAt <= now) pendingVerifications.delete(code)
	}
}

function mintVerificationCode(discordId: bigint): { code: string; expiresAt: number } {
	const now = Date.now()
	sweepVerifications(now)
	// one live code per user: minting again is how somebody who lost the first one recovers, and leaving the old one
	// standing would keep a usable code alive that nobody is watching for
	for (const [code, pending] of pendingVerifications) {
		if (pending.discordId === discordId) pendingVerifications.delete(code)
	}
	let code = ''
	for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[Crypto.randomInt(CODE_ALPHABET.length)]
	const expiresAt = now + VERIFICATION_TTL_MS
	pendingVerifications.set(code, { discordId, expiresAt })
	return { code, expiresAt }
}

// A code is spent the instant it reaches chat, which is what makes it safe to type somewhere public -- but only
// while SLM is there to read it. One sent while rcon was down stays unspent and sits in the scrollback, so
// reconnecting voids every outstanding code rather than trusting that none of them were said out loud.
export function invalidatePendingSteamLinkCodes() {
	pendingVerifications.clear()
}

// Links the sender's steam account to whoever minted `code`. Called from the chat command, so the steam id is the
// one the game server reports for the message, not one anybody chose.
export async function consumeSteamLinkCode(ctx: C.Db & CS.AbortSignal, input: { code: string; steamId: bigint }) {
	const now = Date.now()
	sweepVerifications(now)
	const code = input.code.trim().toUpperCase()
	const pending = pendingVerifications.get(code)
	if (!pending) return { code: 'err:invalid-code' as const }
	const discordId = pending.discordId

	const res = DB.transaction(ctx, {}, (ctx) => {
		const existing = DB.get(ctx, Q.linkOwner({ steam64Id: input.steamId }))
		// left live deliberately: the caller can retry once an admin has removed the other link, and burning the code
		// on a failure they cannot act on from in game just sends them back to the website for nothing
		if (existing && existing.discordId !== discordId) return { code: 'err:steam-already-linked' as const }
		if (existing) return { code: 'ok' as const, discordId }

		DB.run(ctx, Q.insertLink({ steam64Id: input.steamId, discordId, origin: 'self-serve', linkedBy: discordId, createdAt: new Date() }))
		recordUserAccount(ctx, discordId, 'steam-linked', { steamIds: [input.steamId.toString()] })
		return { code: 'ok' as const, discordId }
	})

	if (res.code !== 'ok') return res
	pendingVerifications.delete(code)
	Rbac.invalidateUser(discordId)
	PlayerDiscordRoles.invalidate()
	return { code: 'ok' as const, displayName: await resolveDisplayName(ctx, discordId, 'your account') }
}

// Brings a user's 'discord-connection' links in line with the steam accounts connected to their discord account.
// Links of other origins are left alone. A steam id linked to a different discord account stays where it is. Never
// throws: a failure leaves the links as they were and sign-in carries on.
export function syncDiscordConnectionLinks(ctx: C.Db, discordUser: { id: bigint; username: string }, connectedSteamIds: bigint[]) {
	const discordId = discordUser.id
	let res: { added: bigint[]; removed: bigint[]; conflicts: bigint[] }
	try {
		res = DB.transaction(ctx, {}, (ctx) => {
			const owners = connectedSteamIds.length > 0 ? DB.all(ctx, Q.linkOwners({ ids: connectedSteamIds })) : []
			const ownerBySteamId = new Map(owners.map((row) => [row.steam64Id, row.discordId]))
			const toAdd = connectedSteamIds.filter((id) => !ownerBySteamId.has(id))
			const conflicts = connectedSteamIds.filter((id) => (ownerBySteamId.get(id) ?? discordId) !== discordId)

			const connected = new Set(connectedSteamIds)
			const toRemove = DB.all(ctx, Q.connectionLinkedSteamIds({ discordId }))
				.map((row) => row.steam64Id)
				.filter((id) => !connected.has(id))

			const added: bigint[] = []
			if (toAdd.length > 0) {
				// the link references the discord account, which a first sign-in has not recorded yet
				recordDiscordAccount(ctx, discordId, discordUser.username)
				for (const steam64Id of toAdd) {
					const row = DB.get(
						ctx,
						Q.insertLinkIfFree({ steam64Id, discordId, origin: 'discord-connection', linkedBy: null, createdAt: new Date() }),
					)
					if (row) added.push(row.steam64Id)
				}
				if (added.length > 0) recordUserAccount(ctx, discordId, 'steam-linked', { steamIds: added.map(String) })
			}
			let removed: bigint[] = []
			if (toRemove.length > 0) {
				removed = DB.all(ctx, Q.deleteConnectionLinks({ discordId, ids: toRemove })).map((row) => row.steam64Id)
				if (removed.length > 0) recordUserAccount(ctx, discordId, 'steam-unlinked', { steamIds: removed.map(String) })
			}
			return { code: 'ok' as const, added, removed, conflicts }
		})
	} catch (err) {
		log.error({ err }, 'Failed to sync steam links from the discord connections of %s', discordId)
		return
	}
	log.info(
		'Synced steam links from the discord connections of %s: %d connected, added [%s], removed [%s], linked elsewhere [%s]',
		discordId,
		connectedSteamIds.length,
		res.added.join(', '),
		res.removed.join(', '),
		res.conflicts.join(', '),
	)
	if (res.added.length > 0 || res.removed.length > 0) {
		Rbac.invalidateUser(discordId)
		PlayerDiscordRoles.invalidate()
	}
}

type LinkRow = Schema.LinkedSteamAccount & { username: string }

// Names the assigner, so a link somebody else made says who made it rather than just that it wasn't you. Resolved
// once per distinct actor: the display name goes through discord, and a user usually assigns several at a time.
async function resolveLinkActors(ctx: C.Db, links: LinkRow[]): Promise<USR.SteamAccountLink[]> {
	const actorIds = [...new Set(links.flatMap((l) => (l.linkedBy === null ? [] : [l.linkedBy])))]
	const names = new Map(await Promise.all(actorIds.map(async (id) => [id, await resolveDisplayName(ctx, id, 'a former admin')] as const)))
	return links.map((link) => ({
		steamId: link.steam64Id.toString(),
		discordId: link.discordId.toString(),
		discordUsername: link.username,
		origin: link.origin,
		linkedBy: link.linkedBy === null ? null : { discordId: link.linkedBy.toString(), displayName: names.get(link.linkedBy)! },
		createdAt: link.createdAt,
	}))
}

export const orpcRouter = {
	getLoggedInUser: orpcBase.handler(async ({ context }) => {
		const rbac = await Rbac.getRbacForDiscordUser(context)
		const user: RBAC.UserWithRbac = {
			...context.user,
			perms: rbac.perms,
		}
		return { ...user, wsClientId: context.wsClientId }
	}),
	getUser: orpcBase.input(z.bigint()).handler(async ({ context, input }) => {
		const user = await getUser(context, input)
		if (!user) return { code: 'err:not-found' as const }
		return { code: 'ok' as const, user }
	}),

	getUsers: orpcBase.input(z.array(USR.UserIdSchema).optional()).handler(async ({ context, input }) => {
		const dbUsers = input ? getDbUsers(context, input) : DB.all(context, Q.allUsers({}))
		const users = await buildUsers(dbUsers)
		return { code: 'ok' as const, users }
	}),

	// every link on the caller's account, including ones an admin assigned: a link decides what the person is
	// entitled to in game, so being able to see one somebody else made is the point.
	getMyLinkedSteamAccounts: orpcBase.handler(async ({ context }) => {
		const links = DB.all(context, Q.linksOfDiscordAccount({ discordId: context.user.discordId }))
		return { code: 'ok' as const, links: await resolveLinkActors(context, links) }
	}),

	// Starts the in-game proof of ownership. Unauthenticated in the sense that it needs no permission: it grants
	// nothing on its own, and the code is worthless to anybody who cannot send it from the account being claimed.
	beginSteamLinkVerification: orpcBase.meta({ type: 'mutation' }).handler(async ({ context }) => {
		const { code, expiresAt } = mintVerificationCode(context.user.discordId)
		return { code: 'ok' as const, verificationCode: code, expiresAt }
	}),

	// Replaces the caller's full set of linked steam ids. Additions are refused: a steam id arrives here only once
	// it has been proven in game (see consumeSteamLinkCode), so everything this still does is removals.
	updateLinkedSteamAccounts: orpcBase
		.meta({ type: 'mutation' })
		.input(z.array(z.string()))
		.handler(async ({ context, input }) => {
			const parsed: bigint[] = []
			const seen = new Set<string>()
			for (const raw of input) {
				const res = ZodUtils.Steam64IdSchema.safeParse(raw)
				if (!res.success) return { code: 'err:invalid-steam-id' as const, steamId: raw, msg: `"${raw}" is not a valid Steam64 ID` }
				if (seen.has(res.data)) continue
				seen.add(res.data)
				parsed.push(BigInt(res.data))
			}
			const res = DB.transaction(context, {}, (context) => {
				const discordId = context.user.discordId
				const currentRows = DB.all(context, Q.linkedSteamIds({ discordId }))
				const current = new Set(currentRows.map((r) => r.steam64Id))
				const next = new Set(parsed)
				const added = parsed.filter((id) => !current.has(id))
				const removed = [...current].filter((id) => !next.has(id))

				if (added.length > 0) {
					return { code: 'err:verification-required' as const, steamId: added[0].toString() }
				}

				if (removed.length > 0) {
					DB.run(context, Q.deleteOwnLinks({ discordId, ids: removed }))
					recordUserAccount(context, discordId, 'steam-unlinked', { steamIds: removed.map((id) => id.toString()) })
				}
				return { code: 'ok' as const, steamIds: parsed.map((id) => id.toString()) }
			})
			// after commit: linking changes the caller's linked players, so their resolved perms change. evict +
			// push a refetch to their session (the rbac cache has no TTL, so evicting mid-transaction could repopulate
			// stale from the uncommitted read)
			if (res.code === 'ok') {
				Rbac.invalidateUser(context.user.discordId)
				PlayerDiscordRoles.invalidate()
			}
			return res
		}),

	// the link on one steam account, for the player details window. Behind the same permission as writing one: it
	// puts a name to somebody who has not chosen to show it here.
	getSteamAccountLink: orpcBase.input(z.object({ steamId: z.string() })).handler(async ({ context, input }) => {
		const parsed = ZodUtils.Steam64IdSchema.safeParse(input.steamId)
		if (!parsed.success) return { code: 'err:invalid-steam-id' as const, steamId: input.steamId }

		const links = DB.all(context, Q.linkOfSteamAccount({ steam64Id: BigInt(parsed.data) }))
		const [link] = await resolveLinkActors(context, links)
		return { code: 'ok' as const, link: link ?? null }
	}),

	// Links somebody else's steam account to a discord account. The account need not have signed into SLM, which is
	// why the link points at `discordAccounts` -- but it does have to be a home guild member, since an id we cannot
	// resolve carries no name to show and no roles to read.
	assignSteamLink: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ steamId: z.string(), discordId: z.string() }))
		.handler(async ({ context, input }) => {
			const steam = ZodUtils.Steam64IdSchema.safeParse(input.steamId)
			if (!steam.success) return { code: 'err:invalid-steam-id' as const, steamId: input.steamId }
			let discordId: bigint
			try {
				discordId = BigInt(input.discordId)
			} catch {
				return { code: 'err:invalid-discord-id' as const, discordId: input.discordId }
			}

			const memberRes = await Discord.fetchMember(ENV.DISCORD_HOME_GUILD_ID, discordId)
			if (memberRes.code !== 'ok') return { code: 'err:not-a-guild-member' as const, discordId: input.discordId }
			const username = memberRes.member.user.username

			const steam64Id = BigInt(steam.data)
			const escalationRes = await Rbac.tryDenySteamLinkEscalation(context, discordId, steam64Id)
			if (escalationRes) return escalationRes
			const res = DB.transaction(context, {}, (context) => {
				const existing = DB.get(context, Q.linkOwner({ steam64Id }))
				if (existing && existing.discordId !== discordId) {
					return {
						code: 'err:steam-already-linked' as const,
						steamId: steam.data,
						msg: `Steam ID ${steam.data} is already linked to another account`,
					}
				}
				if (existing) return { code: 'ok' as const, alreadyLinked: true }

				recordDiscordAccount(context, discordId, username)
				DB.run(
					context,
					Q.insertLink({ steam64Id, discordId, origin: 'assigned', linkedBy: context.user.discordId, createdAt: new Date() }),
				)
				recordUserAccount(context, context.user.discordId, 'steam-linked', {
					steamIds: [steam.data],
					subjectDiscordId: discordId.toString(),
				})
				return { code: 'ok' as const, alreadyLinked: false }
			})
			// after commit, for the same reason as the self-serve path: the link changes what both identities resolve to
			if (res.code === 'ok') {
				Rbac.invalidateUser(discordId)
				PlayerDiscordRoles.invalidate()
			}
			return res
		}),

	removeSteamLink: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ steamId: z.string() }))
		.handler(async ({ context, input }) => {
			const steam = ZodUtils.Steam64IdSchema.safeParse(input.steamId)
			if (!steam.success) return { code: 'err:invalid-steam-id' as const, steamId: input.steamId }

			const steam64Id = BigInt(steam.data)
			const linked = DB.get(context, Q.linkOwner({ steam64Id }))
			// Removing a link revokes exactly what adding it granted, so it takes the same standing. Read outside the
			// transaction because the check itself reads the linked set, which the transaction is about to change.
			if (linked) {
				const escalationRes = await Rbac.tryDenySteamLinkEscalation(context, linked.discordId, steam64Id)
				if (escalationRes) return escalationRes
			}

			const res = DB.transaction(context, {}, (context) => {
				const existing = DB.get(context, Q.linkOwner({ steam64Id }))
				if (!existing) return { code: 'err:not-linked' as const }

				DB.run(context, Q.deleteLink({ steam64Id }))
				recordUserAccount(context, context.user.discordId, 'steam-unlinked', {
					steamIds: [steam.data],
					subjectDiscordId: existing.discordId.toString(),
				})
				return { code: 'ok' as const, discordId: existing.discordId }
			})
			if (res.code === 'ok') {
				Rbac.invalidateUser(res.discordId)
				PlayerDiscordRoles.invalidate()
			}
			return res
		}),

	updateNickname: orpcBase
		.meta({ type: 'mutation' })
		.input(z.string().max(64).optional())
		.handler(async ({ context, input }) => {
			return DB.transaction(context, {}, (context) => {
				const user = DB.get(context, Q.userRow({ id: context.user.discordId }))
				if (!user) return { code: 'err:user-not-found' as const, msg: 'User not found.' }

				const nickname = input?.trim() || null
				DB.run(context, Q.setNickname({ id: context.user.discordId, nickname }))
				DB.afterCommit(context, () => {
					context.user.nickname = nickname
					if (nickname) context.user.displayName = nickname
					invalidateUsers$.next({})
				})
				recordUserAccount(context, context.user.discordId, 'nickname-updated', { prevNickname: user.nickname, nickname })

				return { code: 'ok' as const, msg: 'Nickname updated successfully.' }
			})
		}),

	watchUserInvalidation: orpcBase.meta({ logLevel: 'trace' }).handler(async function* ({ context, signal }) {
		const myId = context.user.discordId
		yield* Rx.Ext.toAsyncGenerator(
			invalidateUsers$.pipe(
				Rx.filter((e) => e.discordId === undefined || e.discordId === myId),
				Rx.map(() => undefined),
				Rx.Ext.withAbortSignal(signal!),
			),
		)
	}),
}

export function getDbUser(ctx: C.Db, discordId: bigint): DbUser | undefined {
	return DB.get(ctx, Q.userById({ id: discordId }))
}

export function getDbUsers(ctx: C.Db, discordIds: bigint[]): DbUser[] {
	return DB.all(ctx, Q.usersByIds({ ids: discordIds }))
}

// Records a discord account, or refreshes the username we last saw for it. Called on sign-in and whenever a link is
// assigned to somebody who has never signed in, which is the case the table exists for.
export function recordDiscordAccount(ctx: C.Db, discordId: bigint, username: string) {
	DB.run(ctx, Q.upsertDiscordAccount({ discordId, username, now: new Date() }))
}

export async function getUser(ctx: C.Db, discordId: bigint) {
	const dbUser = getDbUser(ctx, discordId)
	if (!dbUser) return
	return await buildUser(dbUser)
}

// The discord identity a steam account is linked to, which need not have signed into SLM: a link assigned by an
// admin is exactly the case where it has not.
export function findDiscordIdBySteam64Id(ctx: C.Db, steam64Id: bigint): bigint | undefined {
	return DB.get(ctx, Q.linkOwner({ steam64Id }))?.discordId
}

// resolves an in-game (chat) sender's linked SLM account, e.g. for RBAC checks on chat-initiated actions. Unlike
// findDiscordIdBySteam64Id this is users-only: somebody who has never signed in has no SLM account to act as.
export async function findUserBySteam64Id(ctx: C.Db, steam64Id: bigint) {
	const rawUser = DB.get(ctx, Q.userBySteamId({ steam64Id }))
	if (!rawUser) return null
	return buildUser(rawUser)
}

export function findUserSteamIds(ctx: C.Db, userId: bigint) {
	return DB.all(ctx, Q.linkedSteamIds({ discordId: userId })).map((row) => row.steam64Id)
}

export function findUserPlayerIds(ctx: C.Db, userId: bigint) {
	const rows = DB.all(ctx, Q.userPlayerIds({ discordId: userId }))
	let ids: SM.PlayerIds.IdQuery<'eos' | 'steam'>[] = []
	for (const row of rows) {
		if (row.eosid && row.steamId) ids.push({ eos: row.eosid, steam: row.steamId.toString() })
	}
	return ids
}

function selectBestDisplayName(options: (string | null | undefined)[]): string {
	const validOptions = options.filter((opt): opt is string => Boolean(opt?.trim()))
	return validOptions[0] ?? 'Unknown User'
}

// the `users` row joined to its discord account, which is the only shape a display name can be built from
export type DbUser = Schema.User & { username: string }

export async function buildUser(dbUser: DbUser): Promise<USR.User> {
	const memberRes = await Discord.fetchMember(ENV.DISCORD_HOME_GUILD_ID, dbUser.discordId)
	if (memberRes.code !== 'ok') {
		// falling back to the db is what an install without discord does for every user it ever builds, which is
		// a line at boot rather than one per lookup. Discord.fetchMember reports a non-member itself, once.
		if (memberRes.code === 'err:discord') {
			log.warn(`Failed to fetch member for Discord ID ${dbUser.discordId}: ${memberRes.errCode} : ${memberRes.err}`)
		}
		return {
			...dbUser,
			displayName: dbUser.nickname || dbUser.username,
			avatarUrl: USR.getDefaultAvatarUrl(dbUser.discordId),
			displayHexColor: null,
		}
	}
	const member = memberRes.member
	return {
		...dbUser,
		displayName: selectBestDisplayName([
			dbUser.nickname,
			member.displayName,
			member.user.globalName,
			member.user.username,
			dbUser.username,
		]),
		avatarUrl: member.displayAvatarURL({ size: 128 }),
		displayHexColor: member.displayHexColor ?? member.user.hexAccentColor,
	}
}

export async function buildUsers(dbUsers: DbUser[]): Promise<USR.User[]> {
	return Promise.all(dbUsers.map((user) => buildUser(user)))
}

// the single way to turn a user id into text for display. Goes through buildUser so callers get the same name the
// GUI shows (nickname > guild display name > global name > username), rather than each site reimplementing a subset.
export async function resolveDisplayName(ctx: C.Db, userId: USR.UserId, fallback = 'An admin'): Promise<string> {
	const dbUser = getDbUser(ctx, userId)
	if (!dbUser) return fallback
	return (await buildUser(dbUser)).displayName
}
