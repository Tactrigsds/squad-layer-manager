import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseArgs } from 'node:util'

import * as ZodUtils from '@/lib/zod-utils'
import { tsMigrations } from '@/migrations/registry'
import * as CS from '@/models/context-shared.models'
import * as DB from '@/server/db'
import * as Env from '@/server/env'
import { ensureLoggerSetup } from '@/server/logger'
import * as Migrate from '@/server/migrate'
import * as MatchTalliesShared from '@/systems/match-tallies.shared'

import * as DevInstance from '../dev/instance.ts'
import * as Instance from '../load/instance.ts'
import * as Profile from '../load/profile.ts'
import * as SeedHistory from '../load/seed-history.ts'

// Writes a database of synthetic match history for `pnpm load --db`, then settles it: the app boots on the database
// until it has tallied every match, as a production database long since has, and compacts the matches older than its
// archive window. A run on a settled database measures steady state rather than that catch-up.
// docs/developers/load-testing.md says how to size it.
//
//   pnpm load:seed --out data/load/3-servers.sqlite3 --servers 3 --matches 300

process.env.NODE_ENV ??= 'test'
Env.ensureEnvSetup()
ensureLoggerSetup()

const args = parseArgs({
	options: {
		out: { type: 'string' },
		servers: { type: 'string', default: '1' },
		matches: { type: 'string', default: '100' },
		players: { type: 'string', default: '100' },
		pool: { type: 'string', default: '1500' },
		'match-length': { type: 'string', default: '60m' },
		'chat-per-min': { type: 'string', default: String(Profile.DEFAULT_CHAT_PER_MINUTE) },
		force: { type: 'boolean', default: false },
		'no-settle': { type: 'boolean', default: false },
		// settles a database seeded earlier, without seeding it again
		'settle-only': { type: 'boolean', default: false },
	},
	allowPositionals: false,
})
const v = args.values
if (!v.out) {
	console.error('--out is required')
	process.exit(1)
}
const out = path.resolve(v.out)
if (fs.existsSync(out) && !v.force && !v['settle-only']) {
	console.error(`${out} already exists. Pass --force to replace it.`)
	process.exit(1)
}
const matchLengthMs = ZodUtils.tryParseHumanTimeToken(v['match-length'])
if (!matchLengthMs) throw new Error(`--match-length must be a duration (got ${v['match-length']})`)
const matchDurationMs: number = matchLengthMs

DevInstance.ensureLayerData()
const serverIds = Array.from({ length: Number(v.servers) }, (_, i) => Instance.serverIdAt(i))
if (!v['settle-only']) await seed()
if (!v['no-settle']) await settle()
console.log(`${out}: ${(fs.statSync(out).size / 1024 / 1024).toFixed(0)}MB`)

async function seed() {
	fs.mkdirSync(path.dirname(out), { recursive: true })
	for (const suffix of ['', '-wal', '-shm']) fs.rmSync(out + suffix, { force: true })
	const driver = new Database(out)
	driver.pragma('journal_mode = WAL')
	const started = performance.now()
	try {
		await Migrate.runMigrations(driver, { sqlDir: path.resolve('drizzle-sqlite'), tsMigrations })
		// the run that boots on this database points its servers at live emulators; nothing listens here
		Instance.configure(driver, {
			serverIds,
			users: [],
			rconPorts: serverIds.map(() => 1),
			logPaths: serverIds.map(() => '/dev/null'),
			adminsCfgPaths: serverIds.map(() => '/dev/null'),
			fresh: true,
		})
		const { events } = await SeedHistory.seed({
			driver,
			serverIds,
			matchesPerServer: Number(v.matches),
			players: Number(v.players),
			populationPool: Number(v.pool),
			matchDurationMs,
			chatPerMinute: Number(v['chat-per-min']),
			endAt: Date.now(),
			log: (line) => console.log(line),
		})
		console.log(`wrote ${events} events in ${((performance.now() - started) / 1000).toFixed(0)}s`)
		driver.pragma('wal_checkpoint(TRUNCATE)')
	} finally {
		driver.close()
	}
}

// Boots the app on a copy, waits until no server has a match left to tally, has the app compact the matches older than
// its archive window, and puts the settled copy back.
async function settle() {
	const dir = fs.mkdtempSync(path.join(path.dirname(out), '.settle-'))
	const started = performance.now()
	const inst = await Instance.start({ dir, servers: serverIds.length, users: [], adminSteamIds: () => [], limits: {}, db: out })
	try {
		const reader = new Database(inst.dbPath, { readonly: true })
		const ctx = { ...CS.init(), db: DB.connect(reader) }
		try {
			for (;;) {
				const pending = serverIds.filter((serverId) => DB.get(ctx, MatchTalliesShared.Q.anyPendingMatch({ serverId, skip: [] })))
				if (pending.length === 0) break
				if (inst.child.exitCode !== null) throw new Error(`the app exited while settling; see ${inst.logFile}`)
				await new Promise((r) => setTimeout(r, 5_000))
			}
		} finally {
			reader.close()
		}
		console.log(`tallied in ${((performance.now() - started) / 1000).toFixed(0)}s; compacting aged matches`)
		console.log(`compacted: ${JSON.stringify(await inst.control('compact-events'))}`)
	} finally {
		await inst.dispose()
	}
	const settled = new Database(inst.dbPath)
	settled.pragma('wal_checkpoint(TRUNCATE)')
	settled.close()
	fs.copyFileSync(inst.dbPath, out)
	fs.rmSync(dir, { recursive: true, force: true })
	console.log(`settled in ${((performance.now() - started) / 1000).toFixed(0)}s`)
}
