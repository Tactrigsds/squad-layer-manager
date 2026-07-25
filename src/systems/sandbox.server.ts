import { Emulator, type EmuPlayer } from '@/emulator'
import * as Verbs from '@/emulator/verbs'
import { distinctDeepEquals, toAsyncGenerator, withAbortSignal } from '@/lib/async'
import type * as CS from '@/models/context-shared'
import * as SB from '@/models/sandbox.models'
import * as SettingsModels from '@/models/settings.models'
import { SandboxConnectionSchema } from '@/models/settings.models'
import * as RBAC from '@/rbac.models'
import type * as C from '@/server/context'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as AdminList from '@/systems/adminlist.server'
import * as CleanupSys from '@/systems/cleanup.server'
import * as Rbac from '@/systems/rbac.server'
import * as Settings from '@/systems/settings.server'
import * as crypto from 'node:crypto'
import * as Rx from 'rxjs'
import { z } from 'zod'

// A sandbox server is a squad server SLM runs itself: src/emulator, bound to a loopback RCON port, with its log
// lines handed straight to the slice. Everything above the connection sees a normal server, which is the point --
// the sandbox exercises the real RCON framing and the real log parser rather than a mock of them.
//
// The instance is owned here rather than by the slice because the slice is disposable: every settings edit calls
// restartSliceIfRunning, and a world that died with it would reset the sandbox out from under whoever was using it.

const module = initModule('sandbox')
const orpcBase = getOrpcBase(module)
let log!: CS.Logger

// The emulated Admins.cfg. Held as structure and rendered to the real file format on read, so the read-only view
// shows what a squad server would actually be handed and the parse path is the production one.
export type SandboxAdminList = {
	// group name -> the permissions it grants
	groups: Map<string, string[]>
	// player name -> the groups they are in
	memberships: Map<string, Set<string>>
}

// SandboxInstance is the Verbs.SandboxHost for a sandbox server: `adminList` is the editable emulated list, which
// the dev host does not have (its admins come from a real Admins.cfg on disk).
export type SandboxInstance = Verbs.SandboxHost & {
	emu: Emulator
	players: Map<string, EmuPlayer>
	list: SandboxAdminList
	// emits after every change, so watchers push rather than poll
	changed$: Rx.Subject<void>
}

// The group an admin gets by default. Its permissions are the ones that actually gate things in SLM: seeing admin
// chat is what puts a player in scope for in-game commands.
export const DEFAULT_ADMIN_GROUP = 'Admin'
const DEFAULT_ADMIN_PERMS = ['canseeadminchat', 'balance', 'cameraman', 'teamchange', 'kick', 'ban', 'chat']
// what the emulated list treats as marking an admin; matches DEFAULT_ADMIN_GROUP's headline permission
export const IDENTIFYING_PERMS = ['canseeadminchat']

function initAdminList(): SandboxAdminList {
	return { groups: new Map([[DEFAULT_ADMIN_GROUP, [...DEFAULT_ADMIN_PERMS]]]), memberships: new Map() }
}

// Squad's Admins.cfg format. A player with no steam id cannot appear, but every emulated player has one.
export function renderAdminsCfg(instance: SandboxInstance): string {
	const lines: string[] = []
	for (const [group, perms] of instance.list.groups) lines.push(`Group=${group}:${perms.join(',')}`)
	for (const [name, groups] of instance.list.memberships) {
		const player = instance.players.get(name)
		if (!player) continue
		for (const group of groups) {
			if (!instance.list.groups.has(group)) continue
			lines.push(`Admin=${player.steam}:${group}`)
		}
	}
	return lines.length > 0 ? lines.join('\n') + '\n' : ''
}

// Editing the list changes who SLM thinks is an admin, and that answer is cached per player per server. Flushing
// rbac is what makes the admin checkbox take effect on the next in-game command rather than in an hour.
function onListChanged(changed$: Rx.Subject<void>) {
	Rbac.invalidateAll()
	changed$.next()
}

const instances = new Map<string, SandboxInstance>()

export function setup() {
	log = module.getLogger()
	CleanupSys.register(() => {
		for (const serverId of [...instances.keys()]) disposeInstance(serverId)
	})
}

// Loopback-only and holds nothing, but it is still the credential on a socket, so it is generated rather than a
// constant: nothing outside this process ever needs to know it.
const RCON_PASSWORD = crypto.randomBytes(24).toString('hex')

export function isSandbox(connections: SettingsModels.ServerConnection): connections is SettingsModels.SandboxConnection {
	return connections.type === 'sandbox'
}

export function getInstance(serverId: string): SandboxInstance | undefined {
	return instances.get(serverId)
}

// Started once per server and kept until the server is deleted or the process exits. The port is ephemeral and
// therefore assigned here rather than configured, so the slice has to ask for it (connectionFor) after this resolves.
export async function ensureInstance(serverId: string, conn: SettingsModels.SandboxConnection): Promise<SandboxInstance> {
	const existing = instances.get(serverId)
	if (existing) return existing

	const emu = new Emulator({
		serverName: conn.serverName,
		maxPlayers: conn.maxPlayers,
		password: RCON_PASSWORD,
	})
	await emu.start({ rconPort: 0 })
	const list = initAdminList()
	const changed$ = new Rx.Subject<void>()
	const instance: SandboxInstance = {
		emu,
		players: new Map(),
		list,
		changed$,
		adminList: {
			isAdmin: (name) => {
				const groups = list.memberships.get(name)
				if (!groups) return false
				for (const group of groups) {
					if ((list.groups.get(group) ?? []).some((p) => IDENTIFYING_PERMS.includes(p))) return true
				}
				return false
			},
			setPlayerGroups: (name, groups) => {
				if (groups.length === 0) list.memberships.delete(name)
				else list.memberships.set(name, new Set(groups))
				onListChanged(changed$)
			},
			defineGroup: (group, permissions) => {
				list.groups.set(group, [...permissions])
				onListChanged(changed$)
			},
			deleteGroup: (group) => {
				list.groups.delete(group)
				// a membership of a group that no longer exists would render an Admin= line pointing at nothing
				for (const [name, groups] of list.memberships) {
					if (!groups.delete(group)) continue
					if (groups.size === 0) list.memberships.delete(name)
				}
				onListChanged(changed$)
			},
			groupNames: () => [...list.groups.keys()],
		},
	}
	instances.set(serverId, instance)
	// the app reads this server's admins from here rather than from a configured source: there is nothing to point
	// a source at, and asking an operator to configure one for an in-memory server would be absurd
	AdminList.registerImplicitList(serverId, () => AdminList.parseAdminsCfg(renderAdminsCfg(instance), IDENTIFYING_PERMS))
	log.info(`Sandbox ${serverId}: emulated server listening for rcon on 127.0.0.1:${emu.rconPort}`)
	return instance
}

export const SEEDED_SERVER_ID = 'sandbox'

// A fresh install has nowhere to click. Seeding a sandbox gives it a server whose queue, filters and chat all
// behave, without asking the operator to own a squad server first.
//
// It becomes the default server only when there is no other, which is exactly the fresh-install case: an install
// that already has real servers gets the sandbox alongside them, never in front of them. Re-creating a deleted
// sandbox would be obnoxious, so the setting -- not the absence of the row -- is what expresses the intent, and
// deleting the row is undone by turning the setting off.
export async function seedServerIfEnabled(ctx: C.Db): Promise<void> {
	if (!Settings.GLOBAL_SETTINGS.seedSandboxServer) return
	const entries = Settings.listServerEntries()
	if (entries.some((e) => e.id === SEEDED_SERVER_ID)) return

	const settings: SettingsModels.ServerSettings = {
		...SettingsModels.PublicServerSettingsSchema.parse({}),
		connections: SandboxConnectionSchema.parse({ type: 'sandbox' }),
	}
	const res = await Settings.createServerEntry(ctx, {
		id: SEEDED_SERVER_ID,
		displayName: 'Sandbox',
		settings,
	})
	if (res.code !== 'ok') {
		log.warn('Could not seed the sandbox server: %s', res.code)
		return
	}
	await Settings.setServerEnabled(ctx, SEEDED_SERVER_ID, true)
	if (entries.length === 0) await Settings.setDefaultServerEntry(ctx, SEEDED_SERVER_ID)
	log.info('Seeded the sandbox server')
}

export function connectionFor(serverId: string): SettingsModels.RconConnection {
	const instance = instances.get(serverId)
	if (!instance) throw new Error(`sandbox ${serverId} has no running emulator`)
	return { host: '127.0.0.1', port: instance.emu.rconPort, password: RCON_PASSWORD }
}

export function disposeInstance(serverId: string) {
	const instance = instances.get(serverId)
	if (!instance) return
	instances.delete(serverId)
	AdminList.unregisterImplicitList(serverId)
	instance.emu.dispose()
	log.info(`Sandbox ${serverId}: emulated server stopped`)
}

// The shape the control window renders. Admin status is derived rather than stored: the checkbox and the group
// picker are two views of the same membership, so there is nothing to keep in sync.
function sandboxState(instance: SandboxInstance) {
	return {
		code: 'ok' as const,
		groups: [...instance.list.groups.entries()].map(([name, permissions]) => ({ name, permissions: [...permissions] })),
		adminsCfg: renderAdminsCfg(instance),
		nextDefaultName: Verbs.nextDefaultName(instance),
		players: [...instance.players.entries()].map(([name, p]) => ({
			name,
			eosId: p.eos,
			steamId: p.steam,
			teamId: p.teamId ?? null,
			squadId: p.squadId ?? null,
			groups: [...(instance.list.memberships.get(name) ?? [])],
			isAdmin: instance.adminList!.isAdmin(name),
		})),
	}
}

export type SandboxState = Extract<ReturnType<typeof sandboxState>, { code: 'ok' }>

export const orpcRouter = {
	// Which of the servers this session can see are sandboxes, so the client knows where to offer the control
	// window at all. Derived from the running instances rather than from settings: those are the only servers
	// `execute` can act on.
	listSandboxServers: orpcBase.handler(async ({ context }) => {
		const ids: string[] = []
		for (const serverId of instances.keys()) {
			if (await Rbac.tryDenyPermissionsForUser(context, RBAC.perm('sandbox:control', { serverId }))) continue
			ids.push(serverId)
		}
		return ids.sort()
	}),

	// The control surface's own state: the puppets this sandbox knows by name and the emulated admin list. The
	// roster, chat and queue as SLM sees them stay the dashboard's job -- this is only what the dashboard cannot
	// show, because it exists nowhere else.
	watchState: orpcBase
		.meta({ logLevel: 'trace' })
		.input(z.object({ serverId: z.string() }))
		.handler(async function* ({ context, input, signal }) {
			const denyRes = await Rbac.tryDenyPermissionsForUser(context, RBAC.perm('sandbox:control', { serverId: input.serverId }))
			if (denyRes) {
				yield denyRes
				return
			}
			const instance = instances.get(input.serverId)
			if (!instance) {
				yield { code: 'err:not-a-sandbox' as const, serverId: input.serverId }
				return
			}
			const obs = instance.changed$.pipe(
				Rx.startWith(undefined),
				Rx.map(() => sandboxState(instance)),
				distinctDeepEquals(),
				withAbortSignal(signal!),
			)
			yield* toAsyncGenerator(obs)
		}),

	// One procedure for every verb: the wire carries the verb name and its args, which are validated against
	// that verb's own schema on arrival (parseVerbArgs, inside execute).
	//
	// This cannot drive a real squad server, and not because of a check it performs: the only thing it can act
	// on is an Emulator this module started, so a serverId naming a real server finds no instance and stops here.
	execute: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string() }).extend(SB.SandboxCommandSchema.shape))
		.handler(async ({ context, input }) => {
			const denyRes = await Rbac.tryDenyPermissionsForUser(context, RBAC.perm('sandbox:control', { serverId: input.serverId }))
			if (denyRes) return denyRes

			const instance = instances.get(input.serverId)
			if (!instance) return { code: 'err:not-a-sandbox' as const, serverId: input.serverId }

			try {
				const output = await Verbs.execute(instance, input.verb, input.args)
				// join/leave/squad all move the state the window renders, and a verb is the only way any of it changes
				instance.changed$.next()
				log.info('Sandbox %s: user %s ran %s', input.serverId, context.user.discordId, input.verb)
				return { code: 'ok' as const, output }
			} catch (err) {
				// a verb rejecting bad input ("no player named X") is an ordinary answer to the caller, not a server fault
				return { code: 'err:rejected' as const, message: err instanceof Error ? err.message : String(err) }
			}
		}),

	// The verb list, so the window renders whatever this build supports rather than a hardcoded copy.
	listVerbs: orpcBase.handler(() =>
		SB.SANDBOX_VERB.map((verb) => ({
			verb,
			usage: SB.SANDBOX_VERBS[verb].usage,
			summary: SB.SANDBOX_VERBS[verb].summary,
		})),
	),
}
