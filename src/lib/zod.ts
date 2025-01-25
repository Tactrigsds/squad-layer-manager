import { z } from 'zod'

export const PercentageSchema = z.number().min(0).max(100)

export const ParsedIntSchema = z
	.string()
	.regex(/^-?\d+$/)
	.transform((val) => parseInt(val, 10))
	.pipe(z.number().int().finite())

export const ParsedFloatSchema = z
	.string()
	.regex(/^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[Nn][Aa][Nn])$/)
	.transform((val) => parseFloat(val))
	.pipe(z.union([z.nan(), z.number()]))

export const ParsedBigIntSchema = z
	.string()
	.regex(/^-?\d+$/)
	.transform((val) => BigInt(val))

export const StrFlag = z
	.string()
	.toLowerCase()
	.pipe(z.union([z.literal('true'), z.literal('false')]))
	.transform((val) => val === 'true')
