import type { MigrationDriver } from '@/server/migrate'

// Restructures each server's connection settings from a `{ rcon, logs }` pair into a single discriminated
// union on `connections.type` with three modes (local / sftp / server-agent):
//   logs.type 'local-file'   -> { type: 'local',        logFile, rcon }
//   logs.type 'sftp'         -> { type: 'sftp',         rcon, sftp: { host,port,username,password,logFile,... } }
//   logs.type 'log-receiver' -> { type: 'server-agent', token }   AND the old `rcon` block is DROPPED
//
// The 'server-agent' mode is the renamed log agent, which now also proxies RCON: the RCON password lives in the
// agent's own local config, never in SLM. So for servers that used the old 'log-receiver' log source we drop the
// SLM-side RCON credentials entirely. BREAKING for those servers: RCON stops working until the operator upgrades
// the agent (slm-log-agent -> slm-server-agent) and supplies RCON host/port/password to it. This is logged below.
//
// The RCON/SFTP passwords are stored sealed (encrypted at rest); this migration only relocates the already-sealed
// blobs structurally and never decrypts them. `settings` is superjson-wrapped ({ json, meta }); the moved values
// are plain strings/numbers so `meta` never references them and is left untouched. Idempotent: a server already
// on the new shape (connections has a `type` discriminant) is skipped. Shapes are inlined per the frozen-in-time
// migration rule.
export async function up(db: MigrationDriver): Promise<void> {
	const serverRows = db.prepare(`SELECT id, settings FROM servers`).all() as { id: string; settings: string | null }[]
	for (const row of serverRows) {
		if (!row.settings) continue
		const wrapper = JSON.parse(row.settings) as { json?: any; meta?: any }
		const connections = wrapper?.json?.connections
		if (!connections || typeof connections !== 'object') continue
		// already migrated: the new shape carries a discriminant, the old one did not
		if ('type' in connections) continue

		const { rcon, logs } = connections
		if (!logs || typeof logs !== 'object') continue

		let next: Record<string, unknown>
		switch (logs.type) {
			case 'local-file':
				next = { type: 'local', logFile: logs.logFile, rcon }
				break
			case 'sftp':
				next = {
					type: 'sftp',
					rcon,
					sftp: {
						host: logs.host,
						port: logs.port,
						username: logs.username,
						password: logs.password,
						logFile: logs.logFile,
						pollInterval: logs.pollInterval,
						reconnectInterval: logs.reconnectInterval,
						maxReconnectAttempts: logs.maxReconnectAttempts,
					},
				}
				break
			case 'log-receiver':
				next = { type: 'server-agent', token: logs.token }
				console.warn(
					`[0079] Server ${row.id}: migrated log-receiver -> server-agent and dropped its SLM-side RCON credentials. `
						+ `RCON will not work until the slm-server-agent is deployed with RCON host/port/password configured.`,
				)
				break
			default:
				// unknown/malformed log source: leave the row untouched rather than corrupting it
				continue
		}

		wrapper.json.connections = next
		db.prepare(`UPDATE servers SET settings = ? WHERE id = ?`).run(JSON.stringify(wrapper), row.id)
	}
}
