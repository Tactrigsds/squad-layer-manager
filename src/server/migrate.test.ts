import DatabaseConstructor, { type Database } from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Zlib from 'node:zlib'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import * as Migrate from './migrate.ts'

// covers the guarantees applyPendingMigrations exists for -- that a migration can't run against a database
// something else has open, and can't run without a snapshot of what it is about to change.

let dir: string
let dbPath: string
let sqlDir: string
let backupsDir: string
let driver: Database

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slm-migrate-test-'))
	dbPath = path.join(dir, 'db.sqlite3')
	sqlDir = path.join(dir, 'sql')
	backupsDir = path.join(dir, 'backups')
	fs.mkdirSync(sqlDir)
	driver = open()
})

afterEach(() => {
	if (driver.open) driver.close()
	fs.rmSync(dir, { recursive: true, force: true })
})

function open() {
	const db = new DatabaseConstructor(dbPath)
	db.pragma('journal_mode = WAL')
	db.pragma('busy_timeout = 100')
	return db
}

function writeSqlMigration(name: string, sql: string) {
	fs.writeFileSync(path.join(sqlDir, `${name}.sql`), sql)
}

function apply(retainCount = 1) {
	return Migrate.applyPendingMigrations(driver, {
		sqlDir,
		tsMigrations: [],
		backup: { dbPath, dir: backupsDir, retainCount },
	})
}

// newest first: the timestamp is in the name
function backupNames() {
	return fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).sort().reverse() : []
}

// backups are timestamped to the second, so two runs in one test land on the same name. Renaming the first out of
// the way is what a real second-apart run gives you for free.
function stashBackup(newName: string) {
	const [name] = backupNames()
	fs.renameSync(path.join(backupsDir, name), path.join(backupsDir, newName))
}

function readBackup(name: string) {
	const restored = path.join(dir, `restored-${name}.sqlite3`)
	fs.writeFileSync(restored, Zlib.gunzipSync(fs.readFileSync(path.join(backupsDir, name))))
	const db = new DatabaseConstructor(restored, { readonly: true })
	try {
		return db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]
	} finally {
		db.close()
	}
}

describe('applyPendingMigrations', () => {
	test('backs the db up before applying, and the backup is the pre-migration state', async () => {
		writeSqlMigration('0001_first', 'CREATE TABLE first (id INTEGER PRIMARY KEY)')
		await apply()
		stashBackup('slm-backup-db-pre-migration-20200101-000000.sqlite3.gz')

		writeSqlMigration('0002_second', 'CREATE TABLE second (id INTEGER PRIMARY KEY)')
		const { applied } = await apply(0)
		expect(applied).toEqual(['0002_second'])

		const names = backupNames()
		expect(names.length).toBe(2)
		// the newest: the db as 0001 left it, which is what a botched 0002 has to be restorable to
		const tables = readBackup(names[0]).map(t => t.name)
		expect(tables).toContain('first')
		expect(tables).not.toContain('second')
	})

	test('takes no backup when nothing is pending', async () => {
		writeSqlMigration('0001_first', 'CREATE TABLE first (id INTEGER PRIMARY KEY)')
		await apply()
		expect(backupNames().length).toBe(1)

		const { applied } = await apply()
		expect(applied).toEqual([])
		expect(backupNames().length).toBe(1)
	})

	test('prunes the retention window, which is shared with the periodic backups', async () => {
		fs.mkdirSync(backupsDir, { recursive: true })
		for (const day of ['05', '06', '07']) fs.writeFileSync(path.join(backupsDir, `slm-backup-db-202001${day}-000000.sqlite3.gz`), '')

		// window of 2: the snapshot about to be taken, plus the newest periodic one
		writeSqlMigration('0001_first', 'CREATE TABLE first (id INTEGER PRIMARY KEY)')
		await apply(2)

		expect(backupNames()).toEqual([
			expect.stringContaining('-pre-migration-'),
			'slm-backup-db-20200107-000000.sqlite3.gz',
		])
	})

	// retention itself (the shared window, the pinned rollback point) is db-backup.test.ts's business

	test('refuses to migrate a db another connection has open, and applies nothing', async () => {
		writeSqlMigration('0001_first', 'CREATE TABLE first (id INTEGER PRIMARY KEY)')
		const other = open()
		// an idle reader, holding no write lock: BEGIN IMMEDIATE would sail straight past this
		other.prepare(`SELECT 1 FROM sqlite_master`).all()
		try {
			await expect(apply()).rejects.toBeInstanceOf(Migrate.DbInUseError)
		} finally {
			other.close()
		}
		expect(backupNames()).toEqual([])
		expect(Migrate.getPendingMigrations(driver, { sqlDir, tsMigrations: [] })).toEqual(['0001_first'])
	})

	test('releases the lock after a run, so the db is usable again', async () => {
		writeSqlMigration('0001_first', 'CREATE TABLE first (id INTEGER PRIMARY KEY)')
		await apply()

		const other = open()
		try {
			expect(() => other.prepare('SELECT COUNT(*) FROM first').get()).not.toThrow()
		} finally {
			other.close()
		}
	})
})
