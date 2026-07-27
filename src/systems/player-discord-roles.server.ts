import * as Schema from '$root/drizzle/schema.ts'
import * as Rx from '@/lib/rxjs'
import type * as CS from '@/models/context-shared'
import * as DB from '@/server/db'
import { initModule } from '@/server/logger'
import * as CleanupSys from '@/systems/cleanup.server'
import * as Discord from '@/systems/discord.server'

// The discord roles reachable from a steam account, for the `discord-role` player grouping rule.
//
// Held as one small map rather than resolved per player: the roster is polled continuously and every poll would
// otherwise be a db read plus a discord lookup per player. What it costs instead is bounded by the number of linked
// accounts, not by the number of players online, and it only rebuilds when something it depends on changes.
//
// Reads are synchronous and never block. A roster poll that lands before the first build stamps no roles, and the
// next one picks them up; a rule matching nothing for a few seconds after boot is not worth making the poll wait.

const module = initModule('player-discord-roles')
let log!: CS.Logger

let rolesBySteamId = new Map<bigint, string[]>()
let sub: { unsubscribe(): void } | null = null

// A guild-wide role edit touches every holder, and members change one at a time; both arrive as a burst. The window
// is long enough to collapse a burst and short enough that an operator granting a role sees it apply.
const REBUILD_DEBOUNCE_MS = 5_000
// a backstop for the changes no event covers: a link written by another process, or an event missed while
// the gateway was disconnected
const REBUILD_INTERVAL_MS = 10 * 60 * 1000

// the role ids on the discord account this steam account is linked to; empty when it is linked to none
export function rolesForSteamId(steamId: bigint | undefined | null): string[] {
	if (steamId === undefined || steamId === null) return []
	return rolesBySteamId.get(steamId) ?? []
}

export function setup() {
	log = module.getLogger()
	// with no guild to read, every rebuild resolves the same empty map; the `discord-role` rule matches nobody
	if (!Discord.isEnabled()) return

	const rebuild$ = Rx.merge(
		Rx.of(undefined),
		Rx.timer(REBUILD_INTERVAL_MS, REBUILD_INTERVAL_MS),
		// a member's roles changing, a role definition changing, and a link being written all change the answer
		Discord.guildRbacEvents$.pipe(Rx.debounceTime(REBUILD_DEBOUNCE_MS)),
		linksChanged$.pipe(Rx.debounceTime(REBUILD_DEBOUNCE_MS)),
	)

	sub = rebuild$.pipe(Rx.exhaustMap(() => Rx.from(rebuild()))).subscribe()
	CleanupSys.register(() => {
		sub?.unsubscribe()
		sub = null
		rolesBySteamId = new Map()
	})
}

// Emitted by the link mutations. Kept here rather than in users.server so the rebuild has one input to listen to,
// and so users.server does not have to know this cache exists.
export const linksChanged$ = new Rx.Subject<void>()

async function rebuild(): Promise<void> {
	try {
		const ctx = DB.addPooledDb({})
		const links = await ctx
			.db()
			.select({ steam64Id: Schema.linkedSteamAccounts.steam64Id, discordId: Schema.linkedSteamAccounts.discordId })
			.from(Schema.linkedSteamAccounts)
		if (links.length === 0) {
			rolesBySteamId = new Map()
			return
		}

		const rolesByDiscordId = await Discord.fetchMembersRoles([...new Set(links.map((l) => l.discordId))])
		const next = new Map<bigint, string[]>()
		for (const link of links) {
			const roles = rolesByDiscordId.get(link.discordId)
			// a link to somebody who has left the guild resolves to no roles rather than to stale ones
			if (roles && roles.length > 0) next.set(link.steam64Id, roles)
		}
		rolesBySteamId = next
	} catch (err) {
		// keeping the previous map is the better failure: rules stop updating rather than every player dropping
		// out of their group at once
		log.warn({ err }, 'Failed to rebuild the steam -> discord role map')
	}
}

// exported for the link mutations to call after they commit
export function invalidate() {
	linksChanged$.next()
}
