import type { MigrationDriver } from '@/server/migrate'

// Moves the SFTP log-tail tuning settings out of the global `squadServer` settings and nests them inside each server's
// own SFTP log connection (connections.logs, type 'sftp'), since they only ever apply to an SFTP log source and are
// naturally per-server:
//   globalSettings.squadServer.sftpPollInterval        -> servers.connections.logs.pollInterval
//   globalSettings.squadServer.sftpReconnectInterval   -> servers.connections.logs.reconnectInterval
//   globalSettings.squadServer.sftpMaxReconnectAttempts-> servers.connections.logs.maxReconnectAttempts
//
// The old global values were shared by every server, so we read them once and copy them onto every SFTP connection that
// doesn't already carry the nested fields, then strip the three keys from the global settings. Without this, a customized
// global tuning value would be silently reset to the schema defaults on load (unknown keys are stripped, the new
// connection fields prefault).
//
// `settings` is stored superjson-wrapped ({ json, meta }) in a drizzle json(text) column; the tuning values are plain
// strings/numbers so the superjson `meta` never references them and is left untouched. Idempotent: a connection that
// already has the nested fields is skipped, and the global keys are only deleted when present. Shapes are inlined per
// the frozen-in-time migration rule.
export async function up(db: MigrationDriver): Promise<void> {
	const DEFAULTS = { pollInterval: '1s', reconnectInterval: '5s', maxReconnectAttempts: 10 }

	const globalRow = db.prepare(`SELECT settings FROM globalSettings WHERE id = 1`).get() as { settings: string } | undefined
	const tuning = { ...DEFAULTS }
	if (globalRow?.settings) {
		const wrapper = JSON.parse(globalRow.settings) as { json?: any; meta?: any }
		const squadServer = wrapper?.json?.squadServer
		if (squadServer && typeof squadServer === 'object') {
			if ('sftpPollInterval' in squadServer) tuning.pollInterval = squadServer.sftpPollInterval
			if ('sftpReconnectInterval' in squadServer) tuning.reconnectInterval = squadServer.sftpReconnectInterval
			if ('sftpMaxReconnectAttempts' in squadServer) tuning.maxReconnectAttempts = squadServer.sftpMaxReconnectAttempts

			let changed = false
			for (const key of ['sftpPollInterval', 'sftpReconnectInterval', 'sftpMaxReconnectAttempts']) {
				if (key in squadServer) {
					delete squadServer[key]
					changed = true
				}
			}
			if (changed) db.prepare(`UPDATE globalSettings SET settings = ? WHERE id = 1`).run(JSON.stringify(wrapper))
		}
	}

	const serverRows = db.prepare(`SELECT id, settings FROM servers`).all() as { id: string; settings: string | null }[]
	for (const row of serverRows) {
		if (!row.settings) continue
		const wrapper = JSON.parse(row.settings) as { json?: any; meta?: any }
		const logs = wrapper?.json?.connections?.logs
		if (!logs || logs.type !== 'sftp') continue
		if ('pollInterval' in logs && 'reconnectInterval' in logs && 'maxReconnectAttempts' in logs) continue

		logs.pollInterval ??= tuning.pollInterval
		logs.reconnectInterval ??= tuning.reconnectInterval
		logs.maxReconnectAttempts ??= tuning.maxReconnectAttempts
		db.prepare(`UPDATE servers SET settings = ? WHERE id = ?`).run(JSON.stringify(wrapper), row.id)
	}
}
