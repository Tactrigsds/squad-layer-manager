import deepEqual from 'fast-deep-equal'
import superjson from 'superjson'
import { isNullOrUndef } from './type-guards'
export function reverseMapping<T extends { [key: string]: string }>(obj: T) {
	// @ts-expect-error it works
	const reversed: { [key in T[keyof T]]: keyof T } = {}
	for (const key in obj) {
		reversed[obj[key]] = key
	}
	return reversed
}

export function deepClone<T>(obj: T) {
	return superjson.parse(superjson.stringify(obj)) as T
}

export function deref<Entry extends { [key: string]: unknown }>(key: keyof Entry, arr: Entry[]) {
	return arr.map((entry) => entry[key])
}

export function exclude<T extends object, K extends keyof T>(obj: T, keys: K[]): Omit<T, K> {
	const result = { ...obj }
	for (const key of keys) {
		delete result[key]
	}
	return result
}

export function selectProps<T extends object, K extends keyof T>(obj: T, selected: [K, ...K[]]) {
	const result: Partial<T> = {}
	for (const key of selected) {
		result[key] = obj[key]
	}
	return result as Pick<T, (typeof selected)[number]>
}

/*
assumes that both objects have the same keys
 */
export function getModifiedProperties<T extends object>(original: T, modified: T) {
	const result: string[] = []
	for (const key in modified) {
		if (original[key] !== modified[key]) {
			result.push(key)
		}
	}
	return result
}

export function objKeys<T extends object>(obj: T) {
	return Object.keys(obj) as (keyof T)[]
}

export function objValues<T extends object>(obj: T) {
	return Object.values(obj) as T[keyof T][]
}

export function objEntries<T extends object>(obj: T) {
	return Object.entries(obj) as [keyof T, T[keyof T]][]
}

export function prefixProps(obj: Record<string, any>, prefix: string) {
	const result: Record<string, any> = {}
	for (const key in obj) {
		result[`${prefix}_${key}`] = obj[key]
	}
	return result
}

export function revLookup<T extends { [key: string]: any }>(obj: T, key: T[keyof T]): keyof T {
	for (const [k, v] of Object.entries(obj)) {
		if (v === key) {
			return k
		}
	}
	return undefined as unknown as keyof T
}

export function flattenObjToAttrs(obj: any, delimiter: string = '_'): Record<string, string> {
	const output: Record<string, string> = {}
	const stack: Array<[any, string]> = [[obj, '']]

	while (stack.length > 0) {
		const [current, prefix] = stack.pop()!

		if (current && typeof current === 'object') {
			if (Array.isArray(current)) {
				for (let i = current.length - 1; i >= 0; i--) {
					stack.push([current[i], prefix ? `${prefix}${delimiter}${i}` : String(i)])
				}
			} else {
				for (const key of Object.keys(current)) {
					stack.push([current[key], prefix ? `${prefix}${delimiter}${key}` : key])
				}
			}
		} else {
			output[prefix] = String(current)
		}
	}

	return output
}

export function map<O extends object, R>(obj: O, callback: (value: O[keyof O], key: keyof O) => R): { [K in keyof O]: R } {
	const output: { [K in keyof O]: R } = {} as { [K in keyof O]: R }
	for (const [key, value] of Object.entries(obj)) {
		output[key as keyof O] = callback(value, key as keyof O)
	}
	return output
}
export function mapRecord<O extends Record<string, any>, R>(
	obj: O,
	callback: (value: O[keyof O], key: keyof O) => R,
): { [K in keyof O]: R } {
	const output: { [K in keyof O]: R } = {} as { [K in keyof O]: R }
	for (const [key, value] of Object.entries(obj)) {
		output[key as keyof O] = callback(value, key as keyof O)
	}
	return output
}

export function flattenShallow(obj: any): any {
	const output: any = {}
	for (const [key, value] of Object.entries(obj)) {
		if (!isNullOrUndef(value) && typeof key === 'object') {
			for (const [keyInner, valueInner] of Object.entries(key)) {
				output[keyInner] = valueInner
			}
		} else if (!isNullOrUndef(value)) {
			output[key] = value
		}
	}
	return output
}

export function isPartial(obj: object, target: object, exclude?: string[]) {
	for (const key of Object.keys(trimUndefined(obj))) {
		if (exclude && exclude.includes(key)) continue
		// @ts-expect-error idgaf
		if (obj[key] !== target[key]) return false
	}
	return true
}

export function trimUndefined<T extends object>(obj: T) {
	const result = {} as T
	for (const key in obj) {
		if (obj[key] !== undefined) {
			result[key] = obj[key]
		}
	}
	return result
}

export function deepMemo() {
	let stored: any = null
	return <T>(obj: T) => {
		if (deepEqual(stored, obj)) return stored
		stored = obj
		return stored as T
	}
}
