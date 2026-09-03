import * as fs from 'node:fs'

import * as SB from '@/models/sandbox.models'

import { type EmuPlayer, steamIdForName } from '../emulator/index.ts'
import type * as Verbs from '../emulator/verbs.ts'
import { ADMINS_CFG_PATH } from './instance.ts'

// The dev host's admin list: the same emulated Admins.cfg the sandbox keeps in memory, except this one is written
// to the file the workspace's app reads back through its `local` admin list source. So `pnpm emuctl set-player-groups`
// works here too.
//
// The default player names are listed in their groups before anyone connects, which is what makes a `bulk-join`
// break down into groups straight away: the app stamps a player's groups when it first sees them, from the copy of
// the list it already holds, so a membership written at the moment they connect would be too late for them.
export type DevAdminList = NonNullable<Verbs.SandboxHost['adminList']> & {
	onPlayerJoined: (player: EmuPlayer) => void
	write: () => void
}

export function createAdminList(args: {
	players: () => Map<string, EmuPlayer>
	// steam ids passed to `pnpm dev --emu-only --admins`, for players the emulator did not name
	extraAdminSteamIds?: readonly string[]
}): DevAdminList {
	const list = SB.initAdminList()
	const extraAdmins = [...(args.extraAdminSteamIds ?? [])]
	// every name `bulk-join` can hand out, in the order it hands them out. The ones the pattern leaves ungrouped are
	// left out of the list entirely, which is what being in no group means.
	for (let i = 0; i < SB.MAX_PLAYERS; i++) {
		const groups = SB.seededGroupsFor(i)
		if (groups.length > 0) list.memberships.set(SB.defaultPlayerName(i), new Set(groups))
	}
	let joined = 0

	function write() {
		// ids are derived from the name, so a player who has not connected still resolves to the id they will have
		const rendered = SB.renderAdminsCfg(list, (name) => args.players().get(name)?.steam ?? steamIdForName(name))
		const extra = extraAdmins.map((steamId) => `Admin=${steamId}:${SB.DEFAULT_ADMIN_GROUP}\n`).join('')
		fs.writeFileSync(ADMINS_CFG_PATH, rendered + extra)
	}

	function nameOf(player: EmuPlayer): string | undefined {
		for (const [name, candidate] of args.players()) {
			if (candidate === player) return name
		}
		return undefined
	}

	return {
		// A player the pattern does not already cover -- `join Alice` rather than a default name -- is put in a group
		// here. A default name is left alone: the prefill above has already decided, including deciding on no group.
		onPlayerJoined: (player) => {
			const name = nameOf(player)
			if (name !== undefined && SB.defaultPlayerIndex(name) === null) {
				const groups = SB.seededGroupsFor(joined++)
				if (groups.length > 0) list.memberships.set(name, new Set(groups))
			}
			write()
		},
		isAdmin: (name) => {
			const groups = list.memberships.get(name)
			if (!groups) return false
			for (const group of groups) {
				if ((list.groups.get(group) ?? []).some((perm) => SB.IDENTIFYING_PERMS.includes(perm))) return true
			}
			return false
		},
		setPlayerGroups: (name, groups) => {
			if (groups.length === 0) list.memberships.delete(name)
			else list.memberships.set(name, new Set(groups))
			write()
		},
		defineGroup: (group, permissions) => {
			list.groups.set(group, [...permissions])
			write()
		},
		deleteGroup: (group) => {
			list.groups.delete(group)
			for (const [name, groups] of list.memberships) {
				if (!groups.delete(group)) continue
				if (groups.size === 0) list.memberships.delete(name)
			}
			write()
		},
		groupNames: () => [...list.groups.keys()],
		write,
	}
}
