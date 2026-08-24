/**
 * Reading, comparing and formatting layers. The raw-text and id parsing internals (parseRawLayerText,
 * parseTeamString, the backwards-compat mappings) stay with the host, as does setLayerData, which
 * swaps the process-wide layer data out from under everything.
 */
export {
	areLayerIdArgsValid,
	areLayersCompatible,
	areLayersPartialMatch,
	ASYMM_GAMEMODES,
	DEFAULT_LAYER_ID,
	findLayerConfigs,
	getDefaultCollection,
	getFactionIdForFactionNameInexact,
	getKnownLayer,
	getKnownLayerId,
	getLayerCommand,
	getLayerConfig,
	getLayerString,
	getSquadcalcUrl,
	isKnownLayer,
	isSeedingOrTrainingLayer,
	layerConfigCollection,
	LayerIdSchema,
	layersEqual,
	lookupDefaultUnit,
	normalize,
	parseLayerId,
	resolveLayerDetails,
	StaticFactionunitConfigs,
	StaticLayerComponents,
	swapFactions,
	swapFactionsInId,
	toLayer,
} from '@/models/layer'
export type {
	FactionUnitConfig,
	FactionUnitConfigMapping,
	KnownLayer,
	LayerConfig,
	LayerId,
	LayerIdArgs,
	UnvalidatedLayer,
} from '@/models/layer'
