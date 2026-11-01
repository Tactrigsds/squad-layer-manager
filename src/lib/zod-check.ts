import type * as z from '@/lib/zod'

// Rejects a schema that would change what it is given, so a check that runs only in development and test reads the
// same data as production.
// - `strict` is for parameters: each object must be z.strictObject, since a plain z.object drops unknown keys.
// - `check` is for JSON columns read through a model's own schema. A plain z.object and an in-place check such as
//   .trim() are allowed, since the column compares what the schema returns with what it read, and refuses a value the
//   schema would have changed.
// - `codec` is for JSON columns whose schema decodes: each object must be z.looseObject, which carries unknown keys
//   through a read and back.
export function checkSchema(schema: z.ZodType, mode: 'strict' | 'check' | 'codec', what: string) {
	const fail = (path: string, why: string): never => {
		throw new TypeError(`${what}: the schema at ${path || '(root)'} ${why}`)
	}
	const seen = new Set<object>()
	const walk = (s: z.ZodType, path: string): void => {
		if (seen.has(s)) return
		seen.add(s)
		const def = (s as unknown as { _zod: { def: Record<string, any> } })._zod.def
		if (def.coerce) fail(path, 'coerces its input')
		switch (def.type) {
			case 'pipe':
				if (mode === 'codec' && def.reverseTransform) {
					walk(def.in, path)
					walk(def.out, path)
					return
				}
				return fail(path, 'transforms its input, which a check skipped in production would not')
			case 'transform':
			case 'default':
			case 'prefault':
			case 'catch':
				return fail(path, `${def.type}s its input, which a check skipped in production would not`)
			case 'object': {
				const catchall = def.catchall?._zod.def.type
				if (mode === 'strict' && catchall !== 'never') fail(path, 'must be z.strictObject: a plain z.object drops unknown keys')
				if (mode === 'codec' && catchall !== 'unknown') fail(path, 'must be z.looseObject: a plain z.object drops unknown keys')
				for (const [k, v] of Object.entries(def.shape as Record<string, z.ZodType>)) walk(v, `${path}.${k}`)
				return
			}
			case 'array':
				return walk(def.element, `${path}[]`)
			case 'optional':
			case 'nullable':
			case 'readonly':
			case 'nonoptional':
				return walk(def.innerType, path)
			case 'union':
				for (const o of def.options as z.ZodType[]) walk(o, path)
				return
			case 'intersection':
				walk(def.left, path)
				return walk(def.right, path)
			case 'record':
				walk(def.keyType, `${path}{key}`)
				return walk(def.valueType, `${path}{}`)
			case 'tuple':
				;(def.items as z.ZodType[]).forEach((x, i) => walk(x, `${path}[${i}]`))
				if (def.rest) walk(def.rest, `${path}[...]`)
				return
			case 'lazy':
				return walk(def.getter(), path)
			default:
				return
		}
	}
	walk(schema, '')
}

export function sameValue(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
	if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
	if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => sameValue(x, b[i]))
	const ka = Object.keys(a)
	const kb = Object.keys(b)
	return ka.length === kb.length && ka.every((k) => sameValue((a as any)[k], (b as any)[k]))
}
