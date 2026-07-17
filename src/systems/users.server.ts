import * as Schema from '$root/drizzle/schema.ts'
import { toAsyncGenerator, withAbortSignal } from '@/lib/async'
import { IsolatedSubject } from '@/lib/isolated-subject'
import { Steam64IdSchema } from '@/lib/zod'
import * as AppEvents from '@/models/app-events.models'
import type * as CS from '@/models/context-shared'
import * as USR from '@/models/users.models'
import type * as RBAC from '@/rbac.models'
import type * as C from '@/server/context'
import * as DB from '@/server/db'
import * as Env from '@/server/env'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as AppEventsSys from '@/systems/app-events.server'
import * as Discord from '@/systems/discord.server'
import * as Rbac from '@/systems/rbac.server'
import * as E from 'drizzle-orm'
import { z } from 'zod'

const invalidateUsers$ = new IsolatedSubject<void>()

const module = initModule('users')
let log!: CS.Logger
const orpcBase = getOrpcBase(module)

const envBuilder = Env.getEnvBuilder({ ...Env.groups.discord })
let ENV!: ReturnType<typeof envBuilder>

export function setup() {
	log = module.getLogger()
	ENV = envBuilder()
}

async function recordUserAccount(
	ctx: C.Db,
	userId: bigint,
	action: AppEvents.UserAccountChanged['action'],
	details?: Pick<AppEvents.UserAccountChanged, 'steamIds' | 'prevNickname' | 'nickname'>,
) {
	await AppEventsSys.persistAppEvent(
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

export const orpcRouter = {
	getLoggedInUser: orpcBase.handler(async ({ context }) => {
		const perms = await Rbac.getUserRbacPerms(context)
		const user: RBAC.UserWithRbac = {
			...context.user,
			perms,
		}
		return { ...user, wsClientId: context.wsClientId }
	}),
	getUser: orpcBase
		.input(z.bigint())
		.handler(async ({ context, input }) => {
			const [dbUser] = await context.db().select().from(Schema.users).where(E.eq(Schema.users.discordId, input))
			const user = await buildUser(dbUser)
			if (!user) return { code: 'err:not-found' as const }
			return { code: 'ok' as const, user }
		}),

	getUsers: orpcBase
		.input(z.array(USR.UserIdSchema).optional())
		.handler(async ({ context, input }) => {
			const dbUsers = await context.db().select().from(Schema.users).where(input ? E.inArray(Schema.users.discordId, input) : undefined)
			const users = await Promise.all(dbUsers.map((dbUser) => buildUser(dbUser)))
			return { code: 'ok' as const, users }
		}),

	getMyLinkedSteamAccounts: orpcBase.handler(async ({ context }) => {
		const rows = await context.db()
			.select({ steam64Id: Schema.linkedSteamAccounts.steam64Id })
			.from(Schema.linkedSteamAccounts)
			.where(E.eq(Schema.linkedSteamAccounts.discordId, context.user.discordId))
		return { code: 'ok' as const, steamIds: rows.map(r => r.steam64Id.toString()) }
	}),

	// replaces the caller's full set of linked steam ids; rejects any id already owned by another discord user
	updateLinkedSteamAccounts: orpcBase
		.meta({ type: 'mutation' })
		.input(z.array(z.string()))
		.handler(async ({ context, input }) => {
			const parsed: bigint[] = []
			const seen = new Set<string>()
			for (const raw of input) {
				const res = Steam64IdSchema.safeParse(raw)
				if (!res.success) return { code: 'err:invalid-steam-id' as const, steamId: raw, msg: `"${raw}" is not a valid Steam64 ID` }
				if (seen.has(res.data)) continue
				seen.add(res.data)
				parsed.push(BigInt(res.data))
			}
			return await DB.runTransaction(context, async (context) => {
				const discordId = context.user.discordId
				if (parsed.length > 0) {
					const [taken] = await context.db()
						.select({ steam64Id: Schema.linkedSteamAccounts.steam64Id })
						.from(Schema.linkedSteamAccounts)
						.where(E.and(
							E.inArray(Schema.linkedSteamAccounts.steam64Id, parsed),
							E.ne(Schema.linkedSteamAccounts.discordId, discordId),
						))
						.limit(1)
					if (taken) {
						return {
							code: 'err:steam-already-linked' as const,
							steamId: taken.steam64Id.toString(),
							msg: `Steam ID ${taken.steam64Id} is already linked to another account`,
						}
					}
				}
				const currentRows = await context.db()
					.select({ steam64Id: Schema.linkedSteamAccounts.steam64Id })
					.from(Schema.linkedSteamAccounts)
					.where(E.eq(Schema.linkedSteamAccounts.discordId, discordId))
				const current = new Set(currentRows.map(r => r.steam64Id))
				const next = new Set(parsed)
				const added = parsed.filter(id => !current.has(id))
				const removed = [...current].filter(id => !next.has(id))

				if (removed.length > 0) {
					await context.db().delete(Schema.linkedSteamAccounts).where(
						E.and(E.eq(Schema.linkedSteamAccounts.discordId, discordId), E.inArray(Schema.linkedSteamAccounts.steam64Id, removed)),
					)
				}
				if (added.length > 0) {
					await context.db().insert(Schema.linkedSteamAccounts).values(added.map(steam64Id => ({ steam64Id, discordId })))
				}
				if (added.length > 0) {
					await recordUserAccount(context, discordId, 'steam-linked', { steamIds: added.map(id => id.toString()) })
				}
				if (removed.length > 0) {
					await recordUserAccount(context, discordId, 'steam-unlinked', { steamIds: removed.map(id => id.toString()) })
				}
				invalidateUsers$.next()
				return { code: 'ok' as const, steamIds: parsed.map(id => id.toString()) }
			})
		}),

	updateNickname: orpcBase
		.meta({ type: 'mutation' })
		.input(z.string().max(64).optional())
		.handler(async ({ context, input }) => {
			return await DB.runTransaction(context, async (context) => {
				const [user] = await context.db().select().from(Schema.users).where(E.eq(Schema.users.discordId, context.user.discordId))
				if (!user) return { code: 'err:user-not-found' as const, msg: 'User not found.' }

				const nickname = input?.trim() || null
				context.user.nickname = nickname
				if (nickname) context.user.displayName = nickname
				invalidateUsers$.next()
				await context.db().update(Schema.users).set({ nickname }).where(E.eq(Schema.users.discordId, context.user.discordId))
				await recordUserAccount(context, context.user.discordId, 'nickname-updated', { prevNickname: user.nickname, nickname })

				return { code: 'ok' as const, msg: 'Nickname updated successfully.' }
			})
		}),

	watchUserInvalidation: orpcBase.meta({ logLevel: 'trace' }).handler(async function*({ signal }) {
		yield* toAsyncGenerator(invalidateUsers$.pipe(withAbortSignal(signal!)))
	}),
}

// resolves an in-game (chat) sender's linked SLM account, e.g. for RBAC checks on chat-initiated actions
export async function findUserBySteam64Id(ctx: C.Db, steam64Id: bigint) {
	const [link] = await ctx.db()
		.select({ discordId: Schema.linkedSteamAccounts.discordId })
		.from(Schema.linkedSteamAccounts)
		.where(E.eq(Schema.linkedSteamAccounts.steam64Id, steam64Id))
	if (!link) return undefined
	const [user] = await ctx.db().select().from(Schema.users).where(E.eq(Schema.users.discordId, link.discordId))
	return user
}

function selectBestDisplayName(options: (string | null | undefined)[]): string {
	const validOptions = options.filter((opt): opt is string => Boolean(opt?.trim()))
	return validOptions[0] ?? 'Unknown User'
}

export async function buildUser(dbUser: Schema.User): Promise<USR.User> {
	const memberRes = await Discord.fetchMember(ENV.DISCORD_HOME_GUILD_ID, dbUser.discordId)
	if (memberRes.code !== 'ok') {
		log.warn(`Failed to fetch member for Discord ID ${dbUser.discordId}: ${memberRes.errCode} : ${memberRes.err}`)
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

export async function buildUsers(dbUsers: Schema.User[]): Promise<USR.User[]> {
	return Promise.all(dbUsers.map(user => buildUser(user)))
}

// the single way to turn a user id into text for display. Goes through buildUser so callers get the same name the
// GUI shows (nickname > guild display name > global name > username), rather than each site reimplementing a subset.
export async function resolveDisplayName(ctx: C.Db, userId: USR.UserId, fallback = 'An admin'): Promise<string> {
	const [dbUser] = await ctx.db().select().from(Schema.users).where(E.eq(Schema.users.discordId, userId)).limit(1)
	if (!dbUser) return fallback
	return (await buildUser(dbUser)).displayName
}
