import * as Schema from '$root/drizzle/schema.ts'
import { toAsyncGenerator, withAbortSignal } from '@/lib/async'
import { createId } from '@/lib/id'
import * as MapUtils from '@/lib/map'
import { addReleaseTask } from '@/lib/nodejs-reentrant-mutexes'
import * as CMD from '@/models/command.models'
import type * as CS from '@/models/context-shared'
import * as USR from '@/models/users.models'
import type * as RBAC from '@/rbac.models'
import type * as C from '@/server/context'
import * as DB from '@/server/db'
import orpcBase from '@/server/orpc-base'
import * as E from 'drizzle-orm/expressions'
import * as Rx from 'rxjs'
import { z } from 'zod'
import { CONFIG } from '@/server/config'
import * as Discord from '@/systems/discord.server'
import * as Rbac from '@/systems/rbac.server'

const state = {
	// linking code -> discordId
	pendingSteamAccountLinks: new Map<string, { discordId: bigint; expirySub: Rx.Subscription }>(),
}
const steamAccountLinkComplete$ = new Rx.Subject<{ discordId: bigint; steam64Id: bigint }>()
const invalidateUsers$ = new Rx.Subject<void>()

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
			const user = await buildUser(context, dbUser)
			if (!user) return { code: 'err:not-found' as const }
			return { code: 'ok' as const, user }
		}),

	getUsers: orpcBase
		.input(z.array(USR.UserIdSchema).optional())
		.handler(async ({ context, input }) => {
			const dbUsers = await context.db().select().from(Schema.users).where(input ? E.inArray(Schema.users.discordId, input) : undefined)
			const users = await Promise.all(dbUsers.map((dbUser) => buildUser(context, dbUser)))
			return { code: 'ok' as const, users }
		}),

	beginSteamAccountLink: orpcBase.handler(async ({ context }) => {
		const discordId = context.user.discordId
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

	cancelSteamAccountLinks: orpcBase.handler(async ({ context }) => {
		let found = false
		for (const [code, { discordId, expirySub }] of state.pendingSteamAccountLinks.entries()) {
			if (discordId === context.user.discordId) {
				state.pendingSteamAccountLinks.delete(code)
				expirySub.unsubscribe()
				found = true
			}
		}
		if (found) return { code: 'ok' as const }
		return { code: 'err:not-found' as const, msg: 'No pending link found for your Discord account.' }
	}),

	watchSteamAccountLinkCompletion: orpcBase.handler(async function*({ context, signal }) {
		const completeForUser$ = steamAccountLinkComplete$.pipe(
			Rx.filter(user => user.discordId === context.user.discordId),
			withAbortSignal(signal!),
		)
		for await (const user of toAsyncGenerator(completeForUser$)) {
			context.user.steam64Id = user.steam64Id
			yield user
		}
	}),

	unlinkSteamAccount: orpcBase.handler(async ({ context }) => {
		return await DB.runTransaction(context, async (context) => {
			const [user] = await context.db().select().from(Schema.users).where(E.eq(Schema.users.discordId, context.user.discordId)).for(
				'update',
			)
			if (!user) return { code: 'err:user-not-found' as const, msg: 'User not found.' }
			if (!user.steam64Id) return { code: 'err:not-linked' as const, msg: 'No Steam account is currently linked.' }

			await context.db().update(Schema.users).set({ steam64Id: null }).where(E.eq(Schema.users.discordId, context.user.discordId))
			context.user.steam64Id = null
			return { code: 'ok' as const, msg: 'Steam account unlinked successfully.' }
		})
	}),

	updateNickname: orpcBase
		.input(z.string().max(64).optional())
		.handler(async ({ context, input }) => {
			return await DB.runTransaction(context, async (context) => {
				const [user] = await context.db().select().from(Schema.users).where(E.eq(Schema.users.discordId, context.user.discordId)).for(
					'update',
				)
				if (!user) return { code: 'err:user-not-found' as const, msg: 'User not found.' }

				const nickname = input?.trim() || null
				context.user.nickname = nickname
				if (nickname) context.user.displayName = nickname
				invalidateUsers$.next()
				await context.db().update(Schema.users).set({ nickname }).where(E.eq(Schema.users.discordId, context.user.discordId))

				return { code: 'ok' as const, msg: 'Nickname updated successfully.' }
			})
		}),

	watchUserInvalidation: orpcBase.handler(async function*({ signal }) {
		yield* toAsyncGenerator(invalidateUsers$.pipe(withAbortSignal(signal!)))
	}),
}

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
		addReleaseTask(() => steamAccountLinkComplete$.next({ discordId: linked.discordId, steam64Id }))
		return { code: 'ok' as const, linkedUsername: user.username }
	})
}

function scheduleCodeExpiry(code: string) {
	return Rx.of(1).pipe(Rx.delay(CONFIG.steamLinkCodeExpiry)).subscribe(() => {
		state.pendingSteamAccountLinks.delete(code)
	})
}

function selectBestDisplayName(options: (string | null | undefined)[]): string {
	const validOptions = options.filter((opt): opt is string => Boolean(opt?.trim()))
	return validOptions[0] ?? 'Unknown User'
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
