import type { MigrationDriver } from '@/server/migrate'

// Moves the `squadServer` block (logFilePollInterval, rconCacheTTL, tickRateThresholds) and
// `postRollAnnouncementsTimeout` out of global settings and into each server's settings, where they belong (they are all
// per-server concerns: log polling, RCON cache freshness, tick-rate display coloring, post-roll announcement timing).
// `fogOffDelay` stays global.
//
// Without this migration the reshaped GlobalSettingsSchema still parses (unknown keys are stripped), but every server
// would silently fall back to the schema defaults for these fields instead of inheriting the operator's global values,
// and an RBAC grant naming `squadServer`/`postRollAnnouncementsTimeout` as a *global* path would take the install down at
// boot (the head segment no longer resolves).
//
// Storage-form wrinkle: global settings persist the ENCODED shape (HumanTime as strings like "5s", because global saves
// go through GlobalSettingsSchema.encode()), while per-server settings persist the DECODED shape (HumanTime as ms
// numbers, because server saves persist the parsed object). So the HumanTime fields have to be converted to milliseconds
// as they move. tickRateThresholds are plain numbers and copy across unchanged.
//
// Everything is stored superjson-wrapped ({ json, meta }); we mutate the plain `.json` payload. All moved values are
// JSON-native (strings/numbers/objects) so the superjson `meta` never references them. Shapes/units inlined per the
// frozen-in-time migration rule.

const HUMAN_TIME_UNITS: Record<string, number> = { w: 604800000, d: 86400000, h: 3600000, m: 60000, s: 1000, ms: 1 }
function toMs(val: unknown): unknown {
	if (typeof val === 'number') return val
	if (typeof val !== 'string') return val
	const match = val.match(/^([0-9.]+)(ms|s|m|h|d|w)$/)
	if (!match) return val
	return parseFloat(match[1]) * HUMAN_TIME_UNITS[match[2]]
}

// full ms-form defaults matching the schema prefaults, for a value the global settings never persisted
const DEFAULT_SQUAD_SERVER = {
	logFilePollInterval: 1000,
	rconCacheTTL: { layersStatus: 5000, serverInfo: 10000, teams: 5000 },
	tickRateThresholds: { good: 60, warning: 50 },
}
const DEFAULT_POST_ROLL_MS = 300000

function convertSquadServer(raw: any): any {
	const ss = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
	const rcon = ss.rconCacheTTL && typeof ss.rconCacheTTL === 'object' ? ss.rconCacheTTL : {}
	const tick = ss.tickRateThresholds && typeof ss.tickRateThresholds === 'object' ? ss.tickRateThresholds : {}
	return {
		logFilePollInterval: ss.logFilePollInterval !== undefined ? toMs(ss.logFilePollInterval) : DEFAULT_SQUAD_SERVER.logFilePollInterval,
		rconCacheTTL: {
			layersStatus: rcon.layersStatus !== undefined ? toMs(rcon.layersStatus) : DEFAULT_SQUAD_SERVER.rconCacheTTL.layersStatus,
			serverInfo: rcon.serverInfo !== undefined ? toMs(rcon.serverInfo) : DEFAULT_SQUAD_SERVER.rconCacheTTL.serverInfo,
			teams: rcon.teams !== undefined ? toMs(rcon.teams) : DEFAULT_SQUAD_SERVER.rconCacheTTL.teams,
		},
		tickRateThresholds: {
			good: typeof tick.good === 'number' ? tick.good : DEFAULT_SQUAD_SERVER.tickRateThresholds.good,
			warning: typeof tick.warning === 'number' ? tick.warning : DEFAULT_SQUAD_SERVER.tickRateThresholds.warning,
		},
	}
}

export async function up(db: MigrationDriver): Promise<void> {
	const gRow = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string } | undefined

	// the ms-form values to distribute to every server (schema defaults if global never had them)
	let squadServerMs: any = convertSquadServer(undefined)
	let postRollMs: unknown = DEFAULT_POST_ROLL_MS
	let gWrapper: { json?: any; meta?: any } | undefined
	let gJson: any
	if (gRow?.settings) {
		gWrapper = JSON.parse(gRow.settings)
		gJson = gWrapper?.json
		if (gJson && typeof gJson === 'object') {
			squadServerMs = convertSquadServer(gJson.squadServer)
			if (gJson.postRollAnnouncementsTimeout !== undefined) postRollMs = toMs(gJson.postRollAnnouncementsTimeout)
		}
	}

	// stamp every server that doesn't already carry the moved fields
	const serverRows = db.prepare(`SELECT id, settings FROM servers`).all() as { id: string; settings: string }[]
	const updateServer = db.prepare(`UPDATE servers SET settings = ? WHERE id = ?`)
	for (const row of serverRows) {
		if (!row.settings) continue
		const wrapper = JSON.parse(row.settings) as { json?: any }
		const json = wrapper?.json
		if (!json || typeof json !== 'object') continue
		let changed = false
		if (!('squadServer' in json)) {
			json.squadServer = squadServerMs
			changed = true
		}
		if (!('postRollAnnouncementsTimeout' in json)) {
			json.postRollAnnouncementsTimeout = postRollMs
			changed = true
		}
		if (changed) updateServer.run(JSON.stringify(wrapper), row.id)
	}

	// remove the moved keys from global + drop any global grants that referenced them (now invalid global paths)
	if (gWrapper && gJson && typeof gJson === 'object') {
		let changed = false
		for (const key of ['squadServer', 'postRollAnnouncementsTimeout']) {
			if (key in gJson) {
				delete gJson[key]
				changed = true
			}
		}
		const roles = gJson.rbac?.roles
		if (roles && typeof roles === 'object') {
			for (const cfg of Object.values(roles) as any[]) {
				const grants = cfg?.globalSettingsGrants
				if (!Array.isArray(grants)) continue
				const filtered = grants.filter((p: unknown) => {
					if (typeof p !== 'string') return true
					const head = p.split('.')[0]
					return head !== 'squadServer' && head !== 'postRollAnnouncementsTimeout'
				})
				if (filtered.length !== grants.length) {
					cfg.globalSettingsGrants = filtered
					changed = true
				}
			}
		}
		if (changed) db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = 1`).run(JSON.stringify(gWrapper))
	}
}
