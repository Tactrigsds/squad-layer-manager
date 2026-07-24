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
//
// A migration must not import app models (they describe the CURRENT shape, which is
// exactly what the migration is moving away from), but `superjson` itself is fair game:
// the JSON columns are superjson-wrapped ({ json, meta }), and a migration touching
// values that `meta` actually references should deserialize/reserialize with superjson
// rather than editing the wrapper by hand.
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
import * as m0073 from './0073_layer_generation_matchup_weights'
import * as m0074 from './0074_command_allowed_prefixes'
import * as m0075 from './0075_rbac_consolidate_per_role'
import * as m0076 from './0076_player_flag_groupings_restructure'
import * as m0077 from './0077_sftp_tuning_into_connection'
import * as m0078 from './0078_admin_list_sources_per_server'
import * as m0079 from './0079_connection_modes'
import * as m0080 from './0080_command_aliases'
import * as m0081 from './0081_player_groupings_by_grouping_id'
import * as m0082 from './0082_block_operators_to_logical_ids'
// 0083/0084 are claimed by the settings-advanced branch (PR #40)
import * as m0085 from './0085_pool_config_single_pool_filter'
import * as m0086 from './0086_fold_broadcasts_into_admin_action_reasons'
import * as m0087 from './0087_id_eq_to_select_layers'
import * as m0088 from './0088_backburner_column'
import * as m0089 from './0089_admin_lists_to_global'
import * as m0090 from './0090_settings_reorg'

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
	{ name: '0073_layer_generation_matchup_weights', up: m0073.up },
	{ name: '0074_command_allowed_prefixes', up: m0074.up },
	{ name: '0075_rbac_consolidate_per_role', up: m0075.up },
	{ name: '0076_player_flag_groupings_restructure', up: m0076.up },
	{ name: '0077_sftp_tuning_into_connection', up: m0077.up },
	{ name: '0078_admin_list_sources_per_server', up: m0078.up },
	{ name: '0079_connection_modes', up: m0079.up },
	{ name: '0080_command_aliases', up: m0080.up },
	{ name: '0081_player_groupings_by_grouping_id', up: m0081.up },
	{ name: '0082_block_operators_to_logical_ids', up: m0082.up },
	{ name: '0085_pool_config_single_pool_filter', up: m0085.up },
	{ name: '0086_fold_broadcasts_into_admin_action_reasons', up: m0086.up },
	{ name: '0087_id_eq_to_select_layers', up: m0087.up },
	{ name: '0088_backburner_column', up: m0088.up },
	{ name: '0089_admin_lists_to_global', up: m0089.up },
	{ name: '0090_settings_reorg', up: m0090.up },
]
