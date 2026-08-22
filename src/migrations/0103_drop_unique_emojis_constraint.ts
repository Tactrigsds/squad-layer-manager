import type { MigrationDriver } from '@/server/migrate'

export async function up(db: MigrationDriver): Promise<void> {
	db.exec('DROP INDEX IF EXISTS `filters_emoji_unique`')
}
