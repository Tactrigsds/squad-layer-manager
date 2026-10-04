import * as Crypto from 'node:crypto'

import type { MigrationDriver } from '@/server/migrate'

// Sessions are now keyed by the sha256 of the token the cookie carries, so a copy of the database holds no usable
// login. Each stored key is the token of a live cookie, so hashing it in place keeps every session signed in.
export async function up(db: MigrationDriver): Promise<void> {
	const rows = db.prepare(`SELECT session FROM sessions`).all() as { session: string }[]
	const update = db.prepare(`UPDATE sessions SET session = ? WHERE session = ?`)
	for (const { session } of rows) {
		update.run(Crypto.createHash('sha256').update(session).digest('hex'), session)
	}
}
