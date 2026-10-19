/**
 * Reading, comparing and formatting layers. A LayerId only means something against the layer data the host has
 * loaded: anything a plugin persists or sends elsewhere should hold toLayerText(id), and read back with
 * fromStoredLayerText. The raw-text parsing internals (parseRawLayerText, parseTeamString, the backwards-compat
 * mappings) stay with the host, as does setLayerData, which swaps the process-wide layer data out from under
 * everything.
 */
export {
	areLayerIdArgsValid,
	areLayersCompatible,
	areLayersPartialMatch,
	ASYMM_GAMEMODES,
	DEFAULT_LAYER_TEXT,
	defaultLayerId,
	findLayerConfigs,
	formatLayerText,
	fromLayerText,
	fromStoredLayerText,
	getDefaultCollection,
	getFactionIdForFactionNameInexact,
	getKnownLayer,
	getKnownLayerId,
	getLayerCommand,
	getLayerConfig,
	getLayerString,
	getSquadcalcUrl,
	idFromParts,
	isDenseLayerId,
	isKnownLayer,
	isSeedingOrTrainingLayer,
	layerConfigCollection,
	LayerIdSchema,
	layersEqual,
	lookupDefaultUnit,
	normalize,
	parseLayerText,
	resolveLayerDetails,
	StaticFactionunitConfigs,
	StaticLayerComponents,
	swapFactions,
	swapFactionsInId,
	toLayer,
	toLayerText,
} from '@/models/layer.models'
export type {
	DenseLayerId,
	FactionUnitConfig,
	FactionUnitConfigMapping,
	KnownLayer,
	LayerConfig,
	LayerId,
	LayerIdArgs,
	LayerTextParts,
	TextLayerId,
	UnvalidatedLayer,
} from '@/models/layer.models'
