/** Schemas and formatters a plugin's config schema is likely to want. */
export {
	BasicStrNoWhitespace,
	enumTupleOptions,
	formatDurationApprox,
	formatHumanTime,
	HumanTime,
	HumanTimeFormat,
	internedEnum,
	internedLiteral,
	NormedUrl,
	parseHumanTime,
	PercentageSchema,
	Steam64IdSchema,
} from '@/lib/zod-utils'
export type { EnumToTuple } from '@/lib/zod-utils'
