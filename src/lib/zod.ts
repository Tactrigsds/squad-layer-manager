import { z } from 'zod'

export const PercentageSchema = z
	.number()
	.min(0)
	.max(100)
	.meta({ description: 'A percentage value between 0 and 100' })

// largest to smallest, so formatHumanTime finds the coarsest unit that divides evenly
const HUMAN_TIME_UNITS = [
	['w', 7 * 24 * 60 * 60 * 1000],
	['d', 24 * 60 * 60 * 1000],
	['h', 60 * 60 * 1000],
	['m', 60 * 1000],
	['s', 1000],
	['ms', 1],
] as const satisfies [string, number][]

export const HumanTimeFormat = z.union([
	z.string().regex(/^[0-9._]+(s|m|h|d|w|ms)$/),
	// numbers are passed through as-is, treated as already being in milliseconds (e.g. a previously-parsed value round-tripped through storage)
	z.number(),
])
export const HumanTime = z.codec(HumanTimeFormat, z.number(), {
	decode: parseHumanTime,
	encode: formatHumanTime,
}).meta({
	description:
		'allows specification of time in seconds, minutes, hours, days, weeks, or milliseconds with the format [number][unit]. converts to milliseconds. numbers are passed through as-is. serializes back to the format using the most convenient round unit',
})

export function parseHumanTime(val: string | number) {
	if (typeof val === 'number') return val
	const match = val.match(/^([0-9.]+)(s|m|h|d|w|ms)$/)
	const [_, numStr, unit] = match!
	const num = parseFloat(numStr!)
	const unitMs = HUMAN_TIME_UNITS.find(([u]) => u === unit)![1]
	return num * unitMs
}

// the strict token form parseHumanTime itself matches (HumanTimeFormat additionally allows underscores/raw
// numbers). shared by command args and the web kick dialog so they accept exactly the same inputs.
const STRICT_HUMAN_TIME_REGEX = /^[0-9.]+(s|m|h|d|w|ms)$/
export function tryParseHumanTimeToken(token: string): number | undefined {
	return STRICT_HUMAN_TIME_REGEX.test(token) ? parseHumanTime(token) : undefined
}

// finds the largest unit that divides the given milliseconds evenly, e.g. 300_000 -> '5m' rather than '300s'
export function formatHumanTime(ms: number) {
	if (ms === 0) return '0ms'
	for (const [unit, unitMs] of HUMAN_TIME_UNITS) {
		if (ms % unitMs === 0) {
			return `${ms / unitMs}${unit}`
		}
	}
	return `${ms}ms`
}

// approximate human duration for display of an arbitrary (non-round) span, e.g. remaining timeout time. shows
// the two coarsest nonzero units, rounded up to the next second so it never reads as "0s" while time remains.
// e.g. 5_398_000 -> '1h 29m', 90_000 -> '1m 30s', 45_000 -> '45s'
export function formatDurationApprox(ms: number): string {
	if (ms <= 0) return '0s'
	let remaining = Math.ceil(ms / 1000) * 1000
	const parts: string[] = []
	// weeks are omitted; a coarser unit than days is overkill for timeout displays, and 'ms' never shows here
	for (const [unit, unitMs] of HUMAN_TIME_UNITS.filter(([u]) => u !== 'w' && u !== 'ms')) {
		if (remaining >= unitMs) {
			parts.push(`${Math.floor(remaining / unitMs)}${unit}`)
			remaining %= unitMs
			if (parts.length === 2) break
		}
	}
	return parts.join(' ')
}

export const ParsedIntSchema = z
	.string()
	.trim()
	.regex(/^-?\d+$/)
	.pipe(z.coerce.number<string>().int())

export const ParsedFloatSchema = z
	.string()
	.trim()
	.regex(/^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[Nn][Aa][Nn])$/)
	.transform((val) => parseFloat(val))
	.pipe(z.union([z.nan(), z.number()]))
	.meta({ description: 'A string representation of a float' })

export const ParsableBigIntSchema = z
	.string()
	.trim()
	.regex(/^-?\d+$/)

export const ParsedBigIntSchema = z
	.string()
	.trim()
	.regex(/^-?\d+$/)
	.pipe(z.coerce.bigint<string>())
	.meta({ description: 'A string representation of a big integer that is parsed to a BigInt' })

export const StrOrNullIfEmptyOrWhitespace = z
	.string()
	.trim()
	.nullable()
	.transform((val) => val || null)
	.meta({ description: 'A string that becomes null if empty or whitespace-only' })

export const NormedUrl = z
	.string()
	.url()
	.overwrite((url) => url.replace(/\/$/, ''))
	.meta({ description: 'A URL with trailing slashes removed' })

export const Steam64IdSchema = z
	.string()
	.trim()
	.regex(/^\d{17}$/, { error: 'Must be a 17-digit Steam64 ID' })
	.meta({ description: 'A 17-digit Steam64 ID' })

export const BasicStrNoWhitespace = z
	.string()
	.regex(/^\S+$/, {
		error: 'Must not contain whitespace',
	})
	.meta({ description: 'A string with no whitespace characters' })

export const PathSegment = z
	.string()
	.trim()
	.min(1, {
		error: 'Path segment cannot be empty',
	})
	.regex(/^[^/\\?%*:|"<>]+$/, {
		error: 'Path segment cannot contain: / \\ ? % * : | " < >',
	})
	.refine((val) => val !== '.' && val !== '..', {
		error: 'Path segment cannot be "." or ".."',
	})
	.meta({
		description: 'A valid path segment that does not contain reserved characters or relative path indicators',
	})

export type EnumToTuple<S extends z.ZodEnum> = [z.infer<S>, ...z.infer<S>[]]

export function enumTupleOptions<S extends z.ZodEnum>(schema: S): EnumToTuple<S> {
	return schema.options as unknown as EnumToTuple<S>
}
