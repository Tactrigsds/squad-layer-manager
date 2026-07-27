import type * as PG from '@/models/player-groupings.models'

// How a grouping rule sources its match, named the way the two systems are named in the settings page rather
// than by the discriminant.
export const groupRuleSourceLabels: Record<PG.GroupRuleSource, string> = {
	battlemetrics: 'BM flag',
	'admin-list': 'Admin group',
}
