import util from 'node:util'

// A value that grants access: a token, a PIN, a key. Every route that would carry it without reveal() throws, so it
// reaches a response, a cache or a string only where a caller reveals it on purpose. Loggers mask it (see
// maskSecrets).
export class Secret<T> {
	#value: T
	constructor(value: T) {
		this.#value = value
		// structuredClone and postMessage cannot clone a function, so a clone fails instead of dropping the value
		Object.defineProperty(this, 'noClone', { value: () => {}, enumerable: true })
	}
	reveal(): T {
		return this.#value
	}
	toJSON(): never {
		return misuse('serialized')
	}
	[Symbol.toPrimitive](): never {
		return misuse('turned into a string or number')
	}
	[util.inspect.custom]() {
		return 'Secret([redacted])'
	}
}

function misuse(how: string): never {
	throw new TypeError(`a Secret was ${how}: call reveal() where the value is meant to go`)
}

// the encoders of secretColumn (drizzle/columns.ts), by which src/server/sql.ts tells a secret column
export const secretEncoders = new WeakSet<object>()

export function isSecret(v: unknown): v is Secret<unknown> {
	return v instanceof Secret
}

// Replaces each Secret in a log record with '[redacted]', copying only the objects that hold one.
export function maskSecrets<T>(v: T, depth = 0): T {
	if (v instanceof Secret) return '[redacted]' as T
	if (depth > 8 || v === null || typeof v !== 'object' || v instanceof Error) return v
	if (Array.isArray(v)) {
		let out: unknown[] | null = null
		for (let i = 0; i < v.length; i++) {
			const m = maskSecrets(v[i], depth + 1)
			if (m !== v[i]) (out ??= [...v])[i] = m
		}
		return (out ?? v) as T
	}
	let out: Record<string, unknown> | null = null
	for (const k in v) {
		const x = (v as Record<string, unknown>)[k]
		const m = maskSecrets(x, depth + 1)
		if (m !== x) (out ??= { ...(v as Record<string, unknown>) })[k] = m
	}
	return (out ?? v) as T
}
