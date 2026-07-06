import type { TsMigration } from '@/server/migrate'

// Ordered registry of hand-written `.ts` data migrations. Each entry is statically
// imported here (not globbed) so the rolldown server bundle includes it in prod.
//
// To add a data migration:
//   1. Copy src/migrations/_template.ts to src/migrations/NNNN_description.ts,
//      using the next free zero-padded number in the shared `.sql`/`.ts` sequence.
//   2. Import it below and append it to the array.
//
// The runner merges these with the `.sql` files in drizzle-sqlite/ and applies all
// of them in filename order, so `name` MUST match the file's numeric prefix and be
// unique across both `.sql` and `.ts` migrations.
export const tsMigrations: TsMigration[] = [
	// import * as m0062 from './0062_backfill_foo'
	// { name: '0062_backfill_foo', up: m0062.up },
]
