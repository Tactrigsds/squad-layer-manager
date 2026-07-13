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
import * as m0062 from './0062_filter_nodes_operator_model'
import * as m0063 from './0063_filter_team_scopes_to_and_or'
import * as m0064 from './0064_rbac_roles_rename_and_flatten_member_roles'
import * as m0065 from './0065_filter_block_operators'
import * as m0066 from './0066_filter_apply_operators'
import * as m0067 from './0067_seed_layer_table_global_setting'
import * as m0068 from './0068_reset_admin_action_reasons'
import * as m0069 from './0069_settings_permissions'
import * as m0070 from './0070_split_kick_and_timeout'
import * as m0071 from './0071_teamswitches_to_teamswaps'
import * as m0072 from './0072_seed_layer_generation_global_setting'

export const tsMigrations: TsMigration[] = [
	{ name: '0062_filter_nodes_operator_model', up: m0062.up },
	{ name: '0063_filter_team_scopes_to_and_or', up: m0063.up },
	{ name: '0064_rbac_roles_rename_and_flatten_member_roles', up: m0064.up },
	{ name: '0065_filter_block_operators', up: m0065.up },
	{ name: '0066_filter_apply_operators', up: m0066.up },
	{ name: '0067_seed_layer_table_global_setting', up: m0067.up },
	{ name: '0068_reset_admin_action_reasons', up: m0068.up },
	{ name: '0069_settings_permissions', up: m0069.up },
	{ name: '0070_split_kick_and_timeout', up: m0070.up },
	{ name: '0071_teamswitches_to_teamswaps', up: m0071.up },
	{ name: '0072_seed_layer_generation_global_setting', up: m0072.up },
]
