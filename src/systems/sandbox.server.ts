import { Emulator, type EmuPlayer } from '@/emulator'
import * as Verbs from '@/emulator/verbs'
import type * as CS from '@/models/context-shared'
import * as SB from '@/models/sandbox.models'
import type * as SettingsModels from '@/models/settings.models'
import * as RBAC from '@/rbac.models'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as CleanupSys from '@/systems/cleanup.server'
import * as Rbac from '@/systems/rbac.server'
import * as crypto from 'node:crypto'
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

export type SandboxInstance = {
	emu: Emulator
	// GUI-facing name -> player. The world keys players by eos id; a scenario names them.
	players: Map<string, EmuPlayer>
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
	const instance: SandboxInstance = { emu, players: new Map() }
	instances.set(serverId, instance)
	log.info(`Sandbox ${serverId}: emulated server listening for rcon on 127.0.0.1:${emu.rconPort}`)
	return instance
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
	instance.emu.dispose()
	log.info(`Sandbox ${serverId}: emulated server stopped`)
}

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

	// The puppets this sandbox knows by name, which is the one piece of world state the client cannot get from
	// the dashboard: the name->player mapping lives here, and every verb addresses players by it. Deliberately a
	// query rather than a stream -- what the roster actually looks like is the dashboard's job to show.
	listPlayers: orpcBase.input(z.object({ serverId: z.string() })).handler(async ({ context, input }) => {
		const denyRes = await Rbac.tryDenyPermissionsForUser(context, RBAC.perm('sandbox:control', { serverId: input.serverId }))
		if (denyRes) return denyRes
		const instance = instances.get(input.serverId)
		if (!instance) return { code: 'err:not-a-sandbox' as const, serverId: input.serverId }
		return {
			code: 'ok' as const,
			players: [...instance.players.entries()].map(([name, p]) => ({
				name,
				eosId: p.eos,
				teamId: p.teamId ?? null,
				squadId: p.squadId ?? null,
			})),
		}
	}),

	// One procedure for every verb: the wire carries the verb name and its args, which are validated against
	// that verb's own schema on arrival (parseVerbArgs, inside execute).
	//
	// This cannot drive a real squad server, and not because of a check it performs: the only thing it can act
	// on is an Emulator this module started, so a serverId naming a real server finds no instance and stops here.
	execute: orpcBase.meta({ type: 'mutation' }).input(
		z.object({ serverId: z.string() }).extend(SB.SandboxCommandSchema.shape),
	).handler(async ({ context, input }) => {
		const denyRes = await Rbac.tryDenyPermissionsForUser(context, RBAC.perm('sandbox:control', { serverId: input.serverId }))
		if (denyRes) return denyRes

		const instance = instances.get(input.serverId)
		if (!instance) return { code: 'err:not-a-sandbox' as const, serverId: input.serverId }

		try {
			const output = await Verbs.execute(instance, input.verb, input.args)
			log.info(
				'Sandbox %s: user %s ran %s',
				input.serverId,
				context.user.discordId,
				input.verb,
			)
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
		}))
	),
}
