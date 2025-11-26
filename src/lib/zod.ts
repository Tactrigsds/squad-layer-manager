import { z } from 'zod'

export const PercentageSchema = z.number().min(0).max(100)

export const HumanTime = z.string().regex(/^[0-9._]+(s|m|h|d|w|ms)$/).transform((val) => {
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
})
	.describe(
		'allows specification of time in seconds, minutes, hours, days, weeks, or milliseconds with the format [number][unit]. converts to milliseconds',
	)

export const ParsedIntSchema = z
	.string()
	.trim()
	.regex(/^-?\d+$/)
	.transform((val) => parseInt(val, 10))
	.pipe(z.number().int().finite())

export const ParsedFloatSchema = z
	.string()
	.trim()
	.regex(/^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[Nn][Aa][Nn])$/)
	.transform((val) => parseFloat(val))
	.pipe(z.union([z.nan(), z.number()]))

export const ParsedBigIntSchema = z
	.string()
	.trim()
	.regex(/^-?\d+$/)
	.transform((val) => BigInt(val))

export const StrFlag = z
	.string()
	.trim()
	.toLowerCase()
	.pipe(z.union([z.literal('true'), z.literal('false')]))
	.transform((val) => val === 'true')

export const StrOrNullIfEmptyOrWhitespace = z.string().trim().nullable().transform((val) => val || null)

export const NormedUrl = z.string().url().transform((url) => url.replace(/\/$/, ''))

export const BasicStrNoWhitespace = z.string().regex(/^\S+$/, {
	message: 'Must not contain whitespace',
})
