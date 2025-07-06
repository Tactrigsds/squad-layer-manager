import * as OneToMany from '@/lib/one-to-many-map'
import { z } from 'zod'
import * as F from './filter.models'
import * as L from './layer'
import * as LC from './layer-columns'
import * as LL from './layer-list.models'
import * as MH from './match-history.models'
import * as SS from './server-state.models'

export type QueriedLayer = L.KnownLayer & { constraints: boolean[] }

export const RepeatRuleFieldSchema = z.enum(['Map', 'Layer', 'Gamemode', 'Faction', 'Alliance', 'Size'])
export type RepeatRuleField = z.infer<typeof RepeatRuleFieldSchema>
export const RepeatRuleSchema = z.object({
	field: RepeatRuleFieldSchema,
	label: z.string().min(1).max(100).optional().describe('A label for the rule'),
	targetValues: z.array(z.string()).optional().describe('A "Whitelist" of values which the rule applies to'),
	within: z.number().min(0).max(50).describe('the number of matches in which this rule applies. if 0, the rule should be ignored'),
})
export type RepeatRule = z.infer<typeof RepeatRuleSchema>

export const LayerQueryConstraintSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('filter-anon'),
		filter: F.FilterNodeSchema,
		applyAs: z.enum(['field', 'where-condition']),
		name: z.string().optional(),
		id: z.string(),
	}),
	z.object({
		type: z.literal('filter-entity'),
		filterEntityId: F.FilterEntityIdSchema,
		applyAs: z.enum(['field', 'where-condition']),
		name: z.string().optional(),
		id: z.string(),
	}),
	z.object({
		type: z.literal('do-not-repeat'),
		rule: RepeatRuleSchema,
		applyAs: z.enum(['field', 'where-condition']),
		name: z.string().optional(),
		id: z.string(),
	}),
])

export type LayerQueryConstraint = z.infer<typeof LayerQueryConstraintSchema>
export type NamedQueryConstraint = LayerQueryConstraint & { name: string }

export function filterToNamedConstrant(
	filter: F.FilterNode,
	id: string,
	name: string,
	applyAs: LayerQueryConstraint['applyAs'] = 'where-condition',
): NamedQueryConstraint {
	return {
		type: 'filter-anon',
		filter,
		applyAs,
		name,
		id,
	}
}

export function filterToConstraint(
	filter: F.FilterNode,
	id: string,
	applyAs: LayerQueryConstraint['applyAs'] = 'where-condition',
): LayerQueryConstraint {
	return {
		type: 'filter-anon',
		filter,
		applyAs,
		id,
	}
}

export function filterEntityToConstraint(
	filterEntity: F.FilterEntity,
	id: string,
	applyAs: LayerQueryConstraint['applyAs'] = 'where-condition',
): LayerQueryConstraint {
	return {
		type: 'filter-entity',
		filterEntityId: filterEntity.id,
		id,
		applyAs,
	}
}

export const LayersQuerySortSchema = z
	.discriminatedUnion('type', [
		z.object({
			type: z.literal('column'),
			sortBy: z.string(),
			sortDirection: z.enum(['ASC', 'DESC']).optional().default('ASC'),
		}),
		z.object({
			type: z.literal('random'),
			seed: z.number().int().positive(),
		}),
	])
	.describe('if not provided, no sorting will be done')

export type LayersQuerySort = z.infer<typeof LayersQuerySortSchema>

export const DEFAULT_SORT: LayersQuerySort = {
	type: 'column',
	sortBy: 'Asymmetry_Score',
	sortDirection: 'ASC',
}
export const DEFAULT_PAGE_SIZE = 20

export type LayersQueryInput = {
	pageIndex?: number
	pageSize?: number
	sort?: LayersQuerySort
	constraints?: LayerQueryConstraint[]
	// Offset of history entries to consider for Repeat rules, where 0 is current layer, 1 is the previous layer, etc,
	historyOffset?: number

	// Layer Ids to be considered as part of the history for Repeat rules,
	previousLayerIds?: L.LayerId[]
}

export type LayerComponentsInput = {
	constraints?: LayerQueryConstraint[]
	previousLayerIds?: L.LayerId[]
}

export type LayerExistsInput = L.LayerId[]

export type SearchIdsInput = {
	queryString: string
	constraints?: LayerQueryConstraint[]
	previousLayerIds?: string[]
}

export type LayerStatusesForLayerQueueInput = {
	queue: LL.LayerList
	pool: SS.PoolConfiguration
}
export type LayerQueryContext = {
	constraints?: LayerQueryConstraint[]

	// ids previous to this one but after any relevant layer history, in the order they would appear in the queue/list
	previousLayerIds?: L.LayerId[]

	// whether to consider stored match history for layers previous to previousLayerIds. defaults to true
	applyMatchHistory?: boolean
}

export type GenLayerQueueItemsOptions = {
	numToAdd: number
	numVoteChoices: number
	itemType: 'layer' | 'vote'
	baseFilterId?: F.FilterEntityId
}

export function getEditedFilterConstraint(filter: F.FilterNode): LayerQueryConstraint {
	return { type: 'filter-anon', id: 'edited-filter', filter, applyAs: 'where-condition' }
}

export type LayerStatuses = {
	// keys are (itemId:(choiceLayerId)?)
	blocked: OneToMany.OneToManyMap<string, string>
	present: Set<L.LayerId>
	violationDescriptors: Map<string, ViolationDescriptor[]>
}

export type ViolationReasonItem = {
	type: 'layer-list-item'
	layerListItemId: string
} | {
	type: 'history-entry'
	historyEntryId: number
}

export type ViolationDescriptor = {
	type: 'repeat-rule'
	constraintId: string
	field:
		| 'Map'
		| 'Gamemode'
		| 'Layer'
		| 'Size'
		| 'Faction_A'
		| 'Faction_B'
		| 'Alliance_A'
		| 'Alliance_B'
		| 'FactionAndUnit_A'
		| 'FactionAndUnit_B'
	reasonItem?: ViolationReasonItem
}

export function resolveViolatedLayerProperties(descriptors: ViolationDescriptor[], teamParity: number) {
	const violatedFields = new Set<string>()
	for (const descriptor of descriptors) {
		// Map ViolationDescriptor fields to KnownLayer fields
		switch (descriptor.field) {
			case 'Faction_A':
				violatedFields.add(MH.getTeamNormalizedFactionProp(teamParity, 'A'))
				break
			case 'Faction_B':
				violatedFields.add(MH.getTeamNormalizedFactionProp(teamParity, 'B'))
				break
			case 'Alliance_A':
				violatedFields.add(MH.getTeamNormalizedAllianceProp(teamParity, 'A'))
				break
			case 'Alliance_B':
				violatedFields.add(MH.getTeamNormalizedAllianceProp(teamParity, 'B'))
				break
			case 'FactionAndUnit_A':
				violatedFields.add(MH.getTeamNormalizedFactionProp(teamParity, 'A'))
				violatedFields.add(MH.getTeamNormalizedUnitProp(teamParity, 'A'))
				break
			case 'FactionAndUnit_B':
				violatedFields.add(MH.getTeamNormalizedFactionProp(teamParity, 'B'))
				violatedFields.add(MH.getTeamNormalizedUnitProp(teamParity, 'B'))
				break
			default:
				violatedFields.add(descriptor.field)
				break
		}
	}
	return violatedFields
}

export function getFactionAndUnitValue(faction: string, unit: string | null | undefined) {
	return faction + '_' + unit || ''
}

export function getLayerStatusId(layerId: L.LayerId, filterEntityId: F.FilterEntityId) {
	return `${layerId}::${filterEntityId}`
}

export const LayerTableConfigSchema = z.object({
	orderedColumns: z.array(z.object({ name: z.string(), visible: z.boolean().optional().describe('default true') })),
	defaultSortBy: LayersQuerySortSchema,
})

export type LayerTableConfig = z.infer<typeof LayerTableConfigSchema>

export type EffectiveColumnAndTableConfig = LayerTableConfig & LC.EffectiveColumnConfig

export function getColVisibilityState(cfg: EffectiveColumnAndTableConfig) {
	return Object.fromEntries(
		Object.values(cfg.defs).map(col => {
			const colDef = cfg.orderedColumns.find(c => c.name === col.name)
			const visible = colDef ? (colDef.visible ?? true) : false
			return [col.name, visible]
		}),
	)
}
