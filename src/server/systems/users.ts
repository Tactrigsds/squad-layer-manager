import * as Schema from '$root/drizzle/schema.ts'
import { toAsyncGenerator, withAbortSignal } from '@/lib/async'
import { createId } from '@/lib/id'
import * as MapUtils from '@/lib/map'
import * as CMD from '@/models/command.models'
import * as CS from '@/models/context-shared'
import * as USR from '@/models/users.models'
import * as RBAC from '@/rbac.models'
import * as C from '@/server/context'
import * as DB from '@/server/db'
import { procedure, router } from '@/server/trpc.server.ts'
import * as D from 'discord.js'
import * as E from 'drizzle-orm/expressions'
import * as Rx from 'rxjs'
import { z } from 'zod'
import { CONFIG } from '../config'
import * as Discord from './discord'
import { getUserRbacPerms as getUserRbacPerms } from './rbac.system'

const state = {
	// linking code -> discordId
	pendingSteamAccountLinks: new Map<string, { discordId: bigint; expirySub: Rx.Subscription }>(),
}
const steamAccountLinkComplete$ = new Rx.Subject<{ discordId: bigint; steam64Id: bigint }>()
const invalidateUsers$ = new Rx.Subject<void>()

export const usersRouter = router({
	getLoggedInUser: procedure.query(async ({ ctx }) => {
		const perms = await getUserRbacPerms(ctx)
		const user: RBAC.UserWithRbac = {
			...ctx.user,
			perms,
		}
		return { ...user, wsClientId: ctx.wsClientId }
	}),
	getUser: procedure.input(z.bigint()).query(async ({ ctx, input }) => {
		const [dbUser] = await ctx.db().select().from(Schema.users).where(E.eq(Schema.users.discordId, input))
		const user = await buildUser(ctx, dbUser)
		if (!user) return { code: 'err:not-found' as const }
		return { code: 'ok' as const, user }
	}),

	getUsers: procedure.input(z.array(USR.UserIdSchema).optional()).query(async ({ ctx, input }) => {
		const dbUsers = await ctx.db().select().from(Schema.users).where(input ? E.inArray(Schema.users.discordId, input) : undefined)
		const users = await Promise.all(dbUsers.map((dbUser) => buildUser(ctx, dbUser)))
		return { code: 'ok' as const, users }
	}),

	beginSteamAccountLink: procedure.mutation(async ({ ctx }) => {
		const discordId = ctx.user.discordId
		const code = createId(9)
		const sub = scheduleCodeExpiry(code)
		const pending = [...MapUtils.filter(state.pendingSteamAccountLinks, (key, value) => value.discordId === value.discordId).keys()]
		for (const code of pending) {
			state.pendingSteamAccountLinks.get(code)?.expirySub.unsubscribe()
			state.pendingSteamAccountLinks.delete(code)
		}
		state.pendingSteamAccountLinks.set(code, { discordId, expirySub: sub })
		return { code: 'ok' as const, command: CMD.buildCommand('linkSteamAccount', { code }, CONFIG.commands, CONFIG.commandPrefix)[0] }
	}),

	cancelSteamAccountLinks: procedure.mutation(async ({ ctx }) => {
		let found = false
		for (const [code, { discordId, expirySub }] of state.pendingSteamAccountLinks.entries()) {
			if (discordId === ctx.user.discordId) {
				state.pendingSteamAccountLinks.delete(code)
				expirySub.unsubscribe()
				found = true
			}
		}
		if (found) return { code: 'ok' as const }
		return { code: 'err:not-found' as const, msg: 'No pending link found for your Discord account.' }
	}),

	watchSteamAccountLinkCompletion: procedure.subscription(async function*({ ctx, signal }) {
		const completeForUser$ = steamAccountLinkComplete$.pipe(
			Rx.filter(user => user.discordId === ctx.user.discordId),
			withAbortSignal(signal!),
		)
		for await (const user of toAsyncGenerator(completeForUser$)) {
			ctx.user.steam64Id = user.steam64Id
			yield user
		}
	}),

	unlinkSteamAccount: procedure.mutation(async ({ ctx }) => {
		return await DB.runTransaction(ctx, async (ctx) => {
			const [user] = await ctx.db().select().from(Schema.users).where(E.eq(Schema.users.discordId, ctx.user.discordId)).for('update')
			if (!user) return { code: 'err:user-not-found' as const, msg: 'User not found.' }
			if (!user.steam64Id) return { code: 'err:not-linked' as const, msg: 'No Steam account is currently linked.' }

			await ctx.db().update(Schema.users).set({ steam64Id: null }).where(E.eq(Schema.users.discordId, ctx.user.discordId))
			ctx.user.steam64Id = null
			return { code: 'ok' as const, msg: 'Steam account unlinked successfully.' }
		})
	}),

	updateNickname: procedure.input(z.string().max(64).optional()).mutation(async ({ ctx, input }) => {
		return await DB.runTransaction(ctx, async (ctx) => {
			const [user] = await ctx.db().select().from(Schema.users).where(E.eq(Schema.users.discordId, ctx.user.discordId)).for('update')
			if (!user) return { code: 'err:user-not-found' as const, msg: 'User not found.' }

			const nickname = input?.trim() || null
			ctx.user.nickname = nickname
			if (nickname) ctx.user.displayName = nickname
			invalidateUsers$.next()
			await ctx.db().update(Schema.users).set({ nickname }).where(E.eq(Schema.users.discordId, ctx.user.discordId))

			return { code: 'ok' as const, msg: 'Nickname updated successfully.' }
		})
	}),

	watchUserInvalidation: procedure.subscription(async function*({ signal }) {
		yield* toAsyncGenerator(invalidateUsers$.pipe(withAbortSignal(signal!)))
	}),
})

export async function completeSteamAccountLink(ctx: CS.Log & C.Db, code: string, steam64Id: bigint) {
	return await DB.runTransaction(ctx, async (ctx) => {
		let [user] = await ctx.db().select().from(Schema.users).where(E.eq(Schema.users.steam64Id, steam64Id))
		if (user) {
			return {
				code: 'err:already-linked' as const,
				msg: ` This Steam account is already linked to another Discord account with username ${user.username} (id: ${user.discordId})`,
			}
		}
		const linked = state.pendingSteamAccountLinks.get(code)
		if (!linked) return { code: 'err:invalid-code' as const, msg: 'Your link code is invalid or has expired.' }
		state.pendingSteamAccountLinks.delete(code)
		linked.expirySub.unsubscribe()
		;[user] = await ctx.db().select().from(Schema.users).where(E.eq(Schema.users.discordId, linked.discordId)).for('update')
		if (!user) return { code: 'err:discord-user-not-found' as const, msg: 'The Discord account that initiated this link was not found.' }
		await ctx.db().update(Schema.users).set({ steam64Id }).where(E.eq(Schema.users.discordId, linked.discordId))
		ctx.tx.unlockTasks.push(() => steamAccountLinkComplete$.next({ discordId: linked.discordId, steam64Id }))
		return { code: 'ok' as const, linkedUsername: user.username }
	})
}

function scheduleCodeExpiry(code: string) {
	return Rx.of(1).pipe(Rx.delay(CONFIG.steamLinkCodeExpiry)).subscribe(() => {
		state.pendingSteamAccountLinks.delete(code)
	})
}

function hasSpecialUnicodeChars(str: string): boolean {
	// Check for emojis and other special unicode characters
	// This regex matches most emoji ranges and other non-basic Latin characters
	const specialUnicodeRegex =
		/[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F900}-\u{1F9FF}]|[\u{1F018}-\u{1F270}]|[\u{238C}-\u{2454}]|[\u{20D0}-\u{20FF}]|[\u{FE00}-\u{FE0F}]|[\u{1F200}-\u{1F2FF}]/u
	return specialUnicodeRegex.test(str)
}

function selectBestDisplayName(options: (string | null | undefined)[]): string {
	const validOptions = options.filter((opt): opt is string => Boolean(opt))
	return validOptions[0]

	// First, try to find an option without special unicode characters
	const cleanOption = validOptions.find(opt => !hasSpecialUnicodeChars(opt))
	if (cleanOption) {
		return cleanOption
	}

	// Fallback to the first available option (original behavior)
	return validOptions[0] || 'Unknown User'
}

export async function buildUser(ctx: CS.Log, dbUser: Schema.User): Promise<USR.User> {
	const memberRes = await Discord.fetchMember(ctx, CONFIG.homeDiscordGuildId, dbUser.discordId)
	if (memberRes.code !== 'ok') {
		ctx.log.warn(`Failed to fetch member for Discord ID ${dbUser.discordId}: ${memberRes.errCode} : ${memberRes.err}`)
		return {
			...dbUser,
			displayName: dbUser.nickname || dbUser.username,
			avatar: null,
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
		avatar: member.avatar ?? member.user.avatar,
		displayHexColor: member.displayHexColor ?? member.user.hexAccentColor,
	}
}

export async function buildUsers(ctx: CS.Log, dbUsers: Schema.User[]): Promise<USR.User[]> {
	return Promise.all(dbUsers.map(user => buildUser(ctx, user)))
}
