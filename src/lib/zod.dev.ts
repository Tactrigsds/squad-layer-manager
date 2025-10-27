import { z } from 'zod'

// browser only
export function devValidate<T extends z.ZodTypeAny>(schema: T, value: any) {
	if ((import.meta as any).env?.DEV) {
		const res = schema.safeParse(value)
		if (!res.success) console.error(res.error)
	}
	return value as z.infer<T>
}
