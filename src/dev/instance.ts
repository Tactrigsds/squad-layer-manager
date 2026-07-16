import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as LayerArtifacts from '@/systems/layer-artifacts.server'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as Paths from '../../paths.ts'
import type * as Slots from './slots.ts'

// One dev instance = one worktree = one slot: the app, the vite dev server, an emulated squad server and a
// stub BattleMetrics api, all on ports derived from the slot. See src/dev/slots.ts.

// Everything the emulator host owns lives here, so a worktree can be reset by deleting one directory.
export const DEV_DIR = path.join(Paths.DATA, 'dev')
export const SQUAD_LOG_PATH = path.join(DEV_DIR, 'SquadGame.log')
export const ADMINS_CFG_PATH = path.join(DEV_DIR, 'Admins.cfg')
export const EMULATOR_LOG_PATH = path.join(DEV_DIR, 'emulator.log')
// where the emulator host listens for scenario commands (`pnpm emuctl`); see src/dev/emu-control.ts
export const EMU_SOCKET_PATH = path.join(DEV_DIR, 'emu.sock')

// The emulator's RCON password. It is reachable only on loopback and holds nothing, so it is a constant
// rather than something each worktree has to be told.
export const RCON_PASSWORD = 'devpassword'

export const ADMIN_GROUP = 'SlmDevAdmin'

// Squad's Admins.cfg format, which the app reads back through a `local` admin list source.
export function renderAdminsCfg(steamIds: string[], group: string, perms: string[]): string {
	const lines = [`Group=${group}:${perms.join(',')}`]
	for (const steamId of steamIds) lines.push(`Admin=${steamId}:${group}`)
	return lines.join('\n') + '\n'
}

// The layer components are static app data, loaded at runtime rather than bundled. The emulator resolves its
// team names from a layer's factions, so anything that builds a World needs them first. Resolved exactly as
// the app under test resolves them, so the layers a scenario reasons about are the ones the app is running.
let layerDataLoaded = false
export function ensureLayerData() {
	if (layerDataLoaded) return
	const file = JSON.parse(fs.readFileSync(LayerArtifacts.resolvePair().layerDataPath, 'utf8')) as L.LayerDataFile
	L.setLayerData({
		components: LC.buildFullLayerComponents(file.components),
		factionUnits: file.factionUnits,
		extraColumns: file.extraColumns,
	})
	layerDataLoaded = true
}

// The env a worktree's processes run with, layered over the .env it shares with the main checkout. Only the
// vars that have to differ per worktree, plus the ones that keep a dev instance from reaching anything real.
export function envOverrides(slot: Slots.Slot): Record<string, string> {
	return {
		NODE_ENV: 'development',
		PORT: String(slot.ports.app),
		HOST: '127.0.0.1',
		CLIENT_PORT: String(slot.ports.client),
		ORIGIN: `http://localhost:${slot.ports.client}`,

		// A dev instance never reaches discord: the oauth callback is built from ORIGIN, so real login would
		// need every slot's port registered as a redirect uri on the discord app. The bypass logs in as any
		// user in the (cloned) db instead -- `?login=<username>`.
		DISCORD_ENABLED: 'false',
		QUERY_PARAM_AUTH_BYPASS: 'true',

		// The stub the emulator host serves. Pointing at the real battlemetrics api would let a worktree write
		// flags and notes to the live org, which is never what an experiment wants.
		BM_HOST: `http://127.0.0.1:${slot.ports.bm}`,

		// One collector serves every worktree; this is what separates their telemetry in grafana.
		OTEL_RESOURCE_ATTRIBUTES: [
			'service.name=slm-dev',
			'deployment.environment.name=dev',
			`slm.worktree=${encodeURIComponent(slot.name)}`,
			`slm.dev.slot=${slot.slot}`,
		].join(','),
	}
}
