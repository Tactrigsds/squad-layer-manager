import { z } from 'zod'

export const ParsedIntSchema = z
	.string()
	.transform((val) => parseInt(val, 10))
	.pipe(z.number().int().finite())

export const ParsedFloatSchema = z
	.string()
	.transform((val) => parseFloat(val))
	.pipe(z.number().finite())

export const ParsedBigIntSchema = z
	.string()
	.transform((val) => BigInt(val))
	.pipe(z.bigint())

export const StrFlag = z
	.string()
	.toLowerCase()
	.pipe(z.union([z.literal('true'), z.literal('false')]))
	.transform((val) => val === 'true')
	.pipe(z.boolean())
