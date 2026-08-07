import { z } from 'zod'

import * as DF from '@/models/demo-fleet.models'
import * as Env from '@/server/env'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as Discord from '@/systems/discord.server'
import * as Settings from '@/systems/settings.server'

// The instance's side of the demo fleet's first-login role pick.
//
// A guild instance boots with nobody able to administer it: it was provisioned by an install rather than deployed,
// so the SUPER_USERS bootstrap a self-hosted SLM uses was never set. Manage Guild in the discord server is what
// stands in (see rbac.server fetchIsSuperUser), and the first holder to arrive names the guild role that runs the
// instance from then on.

const module = initModule('demo-fleet')
const orpcBase = getOrpcBase(module)

const envBuilder = Env.getEnvBuilder({ ...Env.groups.demo })
let ENV!: ReturnType<typeof envBuilder>

export function setup() {
	ENV = envBuilder()
}

export function isGuildInstance(): boolean {
	return !!ENV?.DEMO_LOGIN_TOKEN_PUBKEY
}

export const orpcRouter = {
	// What the first-login dialog asks on every page load, so it stays cheap: a plain instance answers
	// `applies: false` and the client renders nothing.
	setupState: orpcBase.handler(async ({ context: ctx }) => {
		if (!isGuildInstance()) return { code: 'ok' as const, applies: false as const }
		const chosenRoleId = DF.chosenFullAccessRoleId(Settings.GLOBAL_SETTINGS.rbac)
		// the member lookup is a call out to the control plane, and once a role is chosen the answer cannot change
		// what this endpoint says
		if (chosenRoleId !== null) return { code: 'ok' as const, applies: true as const, chosenRoleId, canChoose: false }
		const memberRes = await Discord.fetchMember(ctx.user.discordId)
		return {
			code: 'ok' as const,
			applies: true as const,
			chosenRoleId,
			// only a Manage Guild holder may pick, so that a member cannot race to claim their own guild's instance
			canChoose: memberRes.code === 'ok' && memberRes.member.holdsManageGuild,
		}
	}),

	chooseFullAccessRole: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ roleId: z.string().regex(/^\d+$/) }))
		.handler(async ({ context: ctx, input }) => {
			if (!isGuildInstance()) return { code: 'err:not-a-demo-instance' as const }

			const memberRes = await Discord.fetchMember(ctx.user.discordId)
			if (memberRes.code !== 'ok' || !memberRes.member.holdsManageGuild) return { code: 'err:permission-denied' as const }
			// the pick happens once. Changing it afterwards is editing the role on the settings page, which is
			// where every other permission decision lives.
			if (DF.chosenFullAccessRoleId(Settings.GLOBAL_SETTINGS.rbac) !== null) return { code: 'err:already-chosen' as const }

			const roles = Settings.GLOBAL_SETTINGS.rbac.roles
			const existing = roles[DF.FULL_ACCESS_ROLE_ID]
			if (!existing) return { code: 'err:not-a-demo-instance' as const }

			await Settings.applyGlobalSettings(ctx, {
				rbac: {
					...Settings.GLOBAL_SETTINGS.rbac,
					roles: {
						...roles,
						[DF.FULL_ACCESS_ROLE_ID]: { ...existing, assignments: { ...existing.assignments, discordRoleIds: [input.roleId] } },
					},
				},
			})
			return { code: 'ok' as const }
		}),
}
