import * as DbBackup from '@/server/db-backup'
import { describe, expect, test } from 'vitest'

const DB_PATH = './data/db.sqlite3'

const periodic = (stamp: string) => `slm-backup-db-${stamp}.sqlite3.gz`
const preMigration = (stamp: string) => `slm-backup-db-pre-migration-${stamp}.sqlite3.gz`

function stale(fileNames: string[], retainCount: number, keep?: string) {
	return DbBackup.staleBackupFiles(fileNames, { dbPath: DB_PATH, retainCount, keep })
}

describe('backupFiles', () => {
	test('orders both kinds chronologically, newest first', () => {
		// the pre-migration one is the newest, but sorts last of the three by name: `-pre-migration` comes between the
		// db name and the timestamp, so a name sort would put it first and the dates would mean nothing
		const files = DbBackup.backupFiles(
			[periodic('20260101-000000'), preMigration('20260716-120000'), periodic('20260301-000000')],
			DB_PATH,
		)
		expect(files.map(f => f.name)).toEqual([
			preMigration('20260716-120000'),
			periodic('20260301-000000'),
			periodic('20260101-000000'),
		])
	})

	test('ignores anything that is not a backup of this database', () => {
		const files = DbBackup.backupFiles([
			periodic('20260101-000000'),
			'slm-backup-otherdb-20260101-000000.sqlite3.gz',
			'notes.txt',
			'slm-backup-db-20260101-000000.sqlite3.gz.tmp',
			'slm-backup-db.sqlite3.gz',
		], DB_PATH)
		expect(files.map(f => f.name)).toEqual([periodic('20260101-000000')])
	})

	test('reads the kind back off the name', () => {
		expect(DbBackup.kindOf(preMigration('20260101-000000'), DB_PATH)).toBe('pre-migration')
		expect(DbBackup.kindOf(periodic('20260101-000000'), DB_PATH)).toBe('periodic')
		expect(DbBackup.kindOf('slm-backup-otherdb-20260101-000000.sqlite3.gz', DB_PATH)).toBeNull()
	})

	test('names a backup so it parses back', () => {
		for (const kind of DbBackup.BACKUP_KINDS) {
			const name = DbBackup.fileName(DB_PATH, kind, new Date(2026, 6, 16, 13, 40, 16))
			expect(DbBackup.parseBackupFile(name, DB_PATH)).toEqual({ name, kind, stamp: '20260716134016' })
		}
	})
})

describe('staleBackupFiles', () => {
	test('keeps the newest N across both kinds', () => {
		const files = [
			periodic('20260103-000000'),
			preMigration('20260102-000000'),
			periodic('20260101-000000'),
		]
		expect(stale(files, 2)).toEqual([periodic('20260101-000000')])
	})

	test('never prunes the newest pre-migration backup, however far outside the window it is', () => {
		const rollbackPoint = preMigration('20260101-000000')
		const files = [periodic('20260705-000000'), periodic('20260704-000000'), periodic('20260703-000000'), rollbackPoint]

		// a window of 2 is filled by periodic backups alone, all of them newer than the rollback point
		expect(stale(files, 2)).toEqual([periodic('20260703-000000')])
	})

	test('pins only the newest pre-migration backup, not every one of them', () => {
		const files = [
			periodic('20260705-000000'),
			preMigration('20260704-000000'),
			preMigration('20260101-000000'),
		]
		expect(stale(files, 1)).toEqual([preMigration('20260101-000000')])
	})

	test('keeps everything when the count is 0', () => {
		const files = [periodic('20260101-000000'), preMigration('20250101-000000'), periodic('20240101-000000')]
		expect(stale(files, 0)).toEqual([])
	})

	test('never prunes the file it was told to keep', () => {
		const current = periodic('20260101-000000')
		// deliberately the oldest, so only `keep` can save it
		const files = [periodic('20260703-000000'), periodic('20260702-000000'), current]
		expect(stale(files, 1, current)).toEqual([periodic('20260702-000000')])
	})

	test('leaves files it did not write alone', () => {
		const files = ['db.sqlite3.replaced-20260101-000000', 'slm-backup-otherdb-20260101-000000.sqlite3.gz', 'readme.md']
		expect(stale(files, 1)).toEqual([])
	})
})
