import { z } from 'zod'

export const PercentageSchema = z
	.number()
	.min(0)
	.max(100)
	.meta({ description: 'A percentage value between 0 and 100' })

export const HumanTimeFormat = z
	.string()
	.regex(/^[0-9._]+(s|m|h|d|w|ms)$/)
export const HumanTime = HumanTimeFormat
	.transform(parseHumanTime)
	.meta({
		description:
			'allows specification of time in seconds, minutes, hours, days, weeks, or milliseconds with the format [number][unit]. converts to milliseconds',
	})

export function parseHumanTime(val: string) {
	const match = val.match(/^([0-9.]+)(s|m|h|d|w|ms)$/)
	const [_, numStr, unit] = match!
	const num = parseFloat(numStr!)
	switch (unit) {
		case 's':
			return num * 1000
		case 'm':
			return num * 60 * 1000
		case 'h':
			return num * 60 * 60 * 1000
		case 'd':
			return num * 24 * 60 * 60 * 1000
		case 'w':
			return num * 7 * 24 * 60 * 60 * 1000
		case 'ms':
			return num
		default:
			return num * 1000
	}
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
