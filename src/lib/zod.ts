import { z } from 'zod'

export function parsedNum<T extends z.ZodTypeAny>(type: 'float' | 'int', schema?: T) {
	const base = z
		.string()
		.transform((val) => (type === 'float' ? parseFloat(val) : parseInt(val, 10)))
		.pipe(z.number().refine((n) => !isNaN(n), { message: 'Invalid number' }))
	if (schema) {
		return base.pipe(schema)
	}
	return base
}

export function parsedBigint() {
	const base = z
		.string()
		.transform((val) => BigInt(val))
		.pipe(z.bigint())
	return base
}
