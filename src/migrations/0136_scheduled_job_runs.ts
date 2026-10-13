import type { MigrationDriver } from '@/server/migrate'

// scheduledJobRuns: the runs of the jobs plugins schedule, one row per run. A recurring job's occurrence is claimed
// by inserting its row, keyed "@<dueAt>", before it runs; a one-off run is stored when it is scheduled, under the
// key the plugin gave it. serverId is '' for a job that is not tied to a server, so the unique index covers both.
export async function up(db: MigrationDriver): Promise<void> {
	db.exec(`
		CREATE TABLE IF NOT EXISTS \`scheduledJobRuns\` (
			\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
			\`pluginId\` text NOT NULL,
			\`serverId\` text NOT NULL,
			\`jobId\` text NOT NULL,
			\`key\` text NOT NULL,
			\`kind\` text NOT NULL,
			\`dueAt\` integer NOT NULL,
			\`payload\` text,
			\`state\` text NOT NULL,
			\`attempt\` integer DEFAULT 0 NOT NULL,
			\`nextAttemptAt\` integer,
			\`manual\` integer DEFAULT false NOT NULL,
			\`startedAt\` integer,
			\`finishedAt\` integer,
			\`error\` text,
			\`blockedReason\` text,
			\`cancelRequested\` integer DEFAULT false NOT NULL
		);
		CREATE UNIQUE INDEX IF NOT EXISTS \`scheduledJobRuns_run\` ON \`scheduledJobRuns\` (\`pluginId\`, \`serverId\`, \`jobId\`, \`key\`);
		CREATE INDEX IF NOT EXISTS \`scheduledJobRuns_open\` ON \`scheduledJobRuns\` (\`state\`, \`dueAt\`);
		CREATE INDEX IF NOT EXISTS \`scheduledJobRuns_latestRecurring\` ON \`scheduledJobRuns\` (\`kind\`, \`pluginId\`, \`serverId\`, \`jobId\`, \`dueAt\`);
	`)
}
