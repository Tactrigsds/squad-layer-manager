/**
 * Builders for the filter trees in slm/models/filter. Comparison builders take either raw values or
 * explicit args, so `eq('Map', 'Narva')` and `eq(col('Faction_1'), col('Faction_2'))` both work.
 *
 * A tree written any other way still has to satisfy FilterNodeSchema, and a root has to be a block
 * node. These are the shorter route to both.
 */
export {
	allowMatchups,
	and,
	col,
	disallowMatchups,
	eq,
	excludedFrom,
	gt,
	includedIn,
	inrange,
	inValues,
	isNull,
	isTrue,
	lt,
	nand,
	neq,
	nor,
	notInValues,
	or,
	teamCol,
	val,
	vals,
} from '@/models/filter-builders'
