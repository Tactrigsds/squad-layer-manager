import * as Schema from '$root/drizzle/schema.ts'
import { createId } from '@/lib/id'
import * as CMD from '@/models/command.models'
import * as CS from '@/models/context-shared'
import * as RBAC from '@/rbac.models'
import * as C from '@/server/context'
import { procedure, router } from '@/server/trpc.server.ts'
import * as E from 'drizzle-orm/expressions'
import * as Rx from 'rxjs'
import { z } from 'zod'
import { CONFIG } from '../config'
import { getUserRbacPerms as getUserRbacPerms } from './rbac.system'

const state = {
	// linking code -> discordId
	pendingSteamAccountLinks: new Map<string, { discordId: bigint; expirySub: Rx.Subscription }>(),
}

export const usersRouter = router({
	getLoggedInUser: procedure.query(async ({ ctx }) => {
		const perms = await getUserRbacPerms(ctx, ctx.user.discordId)
		const user: RBAC.UserWithRbac = {
			...ctx.user,
			perms,
		}
		return { ...user, wsClientId: ctx.wsClientId }
	}),
	getUser: procedure.input(z.bigint()).query(async ({ ctx, input }) => {
		const [user] = await ctx.db().select().from(Schema.users).where(E.eq(Schema.users.discordId, input))
		if (!user) return { code: 'err:not-found' as const }
		return { code: 'ok' as const, user }
	}),
	getUsers: procedure.query(async ({ ctx }) => {
		const users = await ctx.db().select().from(Schema.users)
		return { code: 'ok' as const, users }
	}),
	beginSteamAccountLink: procedure.mutation(async ({ ctx }) => {
		const discordId = ctx.user.discordId
		const code = createId(9)
		const sub = scheduleCodeExpiry(code)
		state.pendingSteamAccountLinks.set(code, { discordId, expirySub: sub })
		return { code: 'ok' as const, command: CMD.buildCommand('linkSteamAccount', { code }, CONFIG.commands) }
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
})

export async function completeSteamAccountLink(ctx: CS.Log & C.Db, code: string, steam64Id: bigint) {
	const linked = state.pendingSteamAccountLinks.get(code)
	if (!linked) return { code: 'err:invalid-code' as const, msg: 'Your link code is invalid or has expired.' }
	state.pendingSteamAccountLinks.delete(code)
	linked.expirySub.unsubscribe()
	const [user] = await ctx.db().select().from(Schema.users).where(E.eq(Schema.users.discordId, linked.discordId))
	if (!user) return { code: 'err:discord-user-not-found' as const, msg: 'The Discord account that initiated this link was not found.' }
	await ctx.db().insert(Schema.steamAccounts).values({ discordId: linked.discordId, steam64Id }).execute()
	return { code: 'ok' as const, linkedUsername: user.username }
}

function scheduleCodeExpiry(code: string) {
	return Rx.of(1).pipe(Rx.delay(CONFIG.defaults.steamLinkCodeExpiry)).subscribe(() => {
		state.pendingSteamAccountLinks.delete(code)
	})
}
