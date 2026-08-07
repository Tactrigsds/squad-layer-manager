import Database from 'better-sqlite3'
import * as Crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

import { assertNever } from '@/lib/type-guards'

import * as ControlEnv from './env.ts'
import * as Log from './log.ts'

// Which instances exist, what each is for, and when anyone last touched it. Everything else in the control plane
// reads its answers from here rather than from its own bookkeeping: the proxy learns where to route, the spawner
// which port to hand out, the reaper what has gone quiet, and a restart rebuilds all three from this file.
//
// Its own sqlite file, not the app's: an SLM database describes one server's queue, and the migration runner that
// keeps it current is aimed at that schema. This table is created idempotently instead.

export const KIND = z.enum(['guild', 'ephemeral'])
export type Kind = z.infer<typeof KIND>

// `broken` is terminal until an operator or a fresh install intervenes: the spawner stops retrying and the proxy
// serves a static page on that host rather than a connection refused.
export const STATE = z.enum(['stopped', 'starting', 'running', 'broken'])
export type State = z.infer<typeof STATE>

export type Instance = {
	id: string
	kind: Kind
	guildId: string | null
	slug: string | null
	slot: number
	state: State
	lastActiveAt: number
	createdAt: number
	// how many consecutive starts have failed; reset by a start that reaches healthy
	crashCount: number
	// the child process last spawned for this instance. A child outlives a control plane that was killed rather
	// than asked to stop, and the orphan still holds the port, so the pid is written down rather than only held
	// in the spawner's map.
	pid: number | null
}

type Row = {
	id: string
	kind: string
	guild_id: string | null
	slug: string | null
	slot: number
	state: string
	last_active_at: number
	created_at: number
	crash_count: number
	pid: number | null
}

let db!: Database.Database
let log!: ReturnType<typeof Log.forModule>

export function setup() {
	log = Log.forModule('registry')
	const dir = ControlEnv.get().dataDir
	fs.mkdirSync(dir, { recursive: true })
	db = new Database(path.join(dir, 'registry.sqlite3'))
	db.pragma('journal_mode = WAL')
	// the activity clock is written on request, so a durable fsync per write is the wrong trade: what a crash
	// would cost is a few seconds of `last_active_at`, against a reap threshold measured in tens of minutes
	db.pragma('synchronous = NORMAL')
	db.exec(`
		CREATE TABLE IF NOT EXISTS instances (
			id TEXT PRIMARY KEY,
			kind TEXT NOT NULL,
			guild_id TEXT UNIQUE,
			slug TEXT UNIQUE,
			slot INTEGER NOT NULL UNIQUE,
			state TEXT NOT NULL,
			last_active_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			crash_count INTEGER NOT NULL DEFAULT 0,
			pid INTEGER
		);
		CREATE INDEX IF NOT EXISTS instances_kind ON instances (kind);
	`)
	log.info('registry open at %s', dir)
}

function toInstance(row: Row): Instance {
	return {
		id: row.id,
		kind: KIND.parse(row.kind),
		guildId: row.guild_id,
		slug: row.slug,
		slot: row.slot,
		state: STATE.parse(row.state),
		lastActiveAt: row.last_active_at,
		createdAt: row.created_at,
		crashCount: row.crash_count,
		pid: row.pid,
	}
}

export function all(): Instance[] {
	return db
		.prepare('SELECT * FROM instances ORDER BY created_at')
		.all()
		.map((r) => toInstance(r as Row))
}

export function byId(id: string): Instance | undefined {
	const row = db.prepare('SELECT * FROM instances WHERE id = ?').get(id) as Row | undefined
	return row && toInstance(row)
}

export function byGuild(guildId: string): Instance | undefined {
	const row = db.prepare('SELECT * FROM instances WHERE guild_id = ?').get(guildId) as Row | undefined
	return row && toInstance(row)
}

export function bySlug(slug: string): Instance | undefined {
	const row = db.prepare('SELECT * FROM instances WHERE slug = ?').get(slug) as Row | undefined
	return row && toInstance(row)
}

export function countOfKind(kind: Kind): number {
	const row = db.prepare('SELECT count(*) AS n FROM instances WHERE kind = ?').get(kind) as { n: number }
	return row.n
}

// The subdomain label an instance answers on. Also its identity in every log line, so it is derived rather than
// stored twice. Ingress.resolve is the inverse and has to stay so.
export function host(instance: Instance): string {
	const prefix = ControlEnv.get().DEMO_HOST_PREFIX
	switch (instance.kind) {
		case 'guild':
			return `${prefix}g-${instance.guildId}`
		case 'ephemeral':
			return `${prefix}t-${instance.slug}`
		default:
			assertNever(instance.kind)
	}
}

// The url an instance is reached at from outside, and the only place one is built. Four callers need it -- the
// portal's links, the bot's welcome message, the broker's post-login redirect and the child's own ORIGIN -- and
// three of them are a login that fails silently if the scheme or port is wrong.
export function origin(instance: Instance): string {
	const env = ControlEnv.get()
	return `${env.instanceScheme}://${host(instance)}.${env.DEMO_BASE_DOMAIN}${env.instancePortSuffix}`
}

export function port(instance: Instance): number {
	return ControlEnv.get().DEMO_INSTANCE_PORT_BASE + instance.slot
}

export function dataDir(instance: Instance): string {
	return path.join(ControlEnv.get().dataDir, instance.kind, instance.id)
}

// The lowest free slot, so a fleet that has churned stays packed into a contiguous port range rather than
// scattering across whatever it has ever allocated.
function nextSlot(): number {
	const taken = new Set((db.prepare('SELECT slot FROM instances').all() as { slot: number }[]).map((r) => r.slot))
	for (let slot = 0; ; slot++) {
		if (!taken.has(slot)) return slot
	}
}

export type CreateResult = { code: 'ok'; instance: Instance } | { code: 'err:at-capacity' } | { code: 'err:exists'; instance: Instance }

export function create(args: { kind: Kind; guildId?: string; slug?: string }, now = Date.now()): CreateResult {
	const env = ControlEnv.get()
	const existing = args.guildId ? byGuild(args.guildId) : args.slug ? bySlug(args.slug) : undefined
	if (existing) return { code: 'err:exists', instance: existing }

	const cap = args.kind === 'guild' ? env.DEMO_MAX_GUILD_INSTANCES : env.DEMO_MAX_EPHEMERAL_INSTANCES
	if (countOfKind(args.kind) >= cap) return { code: 'err:at-capacity' }

	const instance: Instance = {
		id: Crypto.randomBytes(8).toString('hex'),
		kind: args.kind,
		guildId: args.guildId ?? null,
		slug: args.slug ?? null,
		slot: nextSlot(),
		state: 'stopped',
		lastActiveAt: now,
		createdAt: now,
		crashCount: 0,
		pid: null,
	}
	db.prepare(
		`INSERT INTO instances (id, kind, guild_id, slug, slot, state, last_active_at, created_at, crash_count, pid)
		 VALUES (@id, @kind, @guildId, @slug, @slot, @state, @lastActiveAt, @createdAt, @crashCount, @pid)`,
	).run(instance)
	log.info({ instanceId: instance.id, kind: instance.kind, slot: instance.slot }, 'provisioned %s', host(instance))
	return { code: 'ok', instance }
}

export function setState(id: string, state: State) {
	db.prepare('UPDATE instances SET state = ? WHERE id = ?').run(state, id)
}

export function setPid(id: string, pid: number | null) {
	db.prepare('UPDATE instances SET pid = ? WHERE id = ?').run(pid, id)
}

export function recordCrash(id: string): number {
	db.prepare('UPDATE instances SET crash_count = crash_count + 1 WHERE id = ?').run(id)
	return byId(id)?.crashCount ?? 0
}

export function clearCrashes(id: string) {
	db.prepare('UPDATE instances SET crash_count = 0 WHERE id = ?').run(id)
}

// Only the reaper reads `last_active_at`, and the shortest threshold it judges against is 45 minutes, so writing
// it more often than this buys nothing. Loading one page is a hundred requests, and the proxy calls touch on
// every one of them.
const TOUCH_RESOLUTION_MS = 10_000
const lastTouch = new Map<string, number>()

// A request is the only evidence the control plane has that anyone is still here.
export function touch(id: string, now = Date.now()) {
	if (now - (lastTouch.get(id) ?? 0) < TOUCH_RESOLUTION_MS) return
	lastTouch.set(id, now)
	db.prepare('UPDATE instances SET last_active_at = ? WHERE id = ?').run(now, id)
}

export function remove(id: string) {
	db.prepare('DELETE FROM instances WHERE id = ?').run(id)
	lastTouch.delete(id)
}

export function close() {
	db?.close()
}
