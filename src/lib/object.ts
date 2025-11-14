import fastDeepEqual from 'fast-deep-equal/es6'
import { current, isDraft } from 'immer'
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
	// Unwrap Immer draft if necessary before cloning
	const unwrapped = isDraft(obj) ? current(obj) : obj
	return structuredClone(unwrapped)
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
export const omit = exclude

export function selectProps<T extends object, K extends keyof T>(obj: T, selected: K[]) {
	const result: Partial<T> = {}
	for (const key of selected) {
		result[key] = obj[key]
	}
	return result as Pick<T, K>
}

export function partition<T extends object, K extends keyof T>(obj: T, ...selected: K[]): [Pick<T, K>, Omit<T, K>] {
	const selectedSet = new Set(selected)
	const picked: Partial<T> = {}
	const omitted: Partial<T> = {}
	for (const key of Object.keys(obj)) {
		if (selectedSet.has(key as K)) {
			picked[key as keyof T] = obj[key as unknown as keyof T]
		} else {
			omitted[key as keyof T] = obj[key as unknown as keyof T]
		}
	}
	return [picked as Pick<T, K>, omitted as Omit<T, K>]
}

export const deepEqual = fastDeepEqual

// for when you walso want to assert that b is assignable to a
export const deepEqualStrict = <A, B extends A>(a: A, b: B): a is B => fastDeepEqual(a, b)

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

export function filterRecord<O extends Record<string, any>, R>(
	obj: O,
	callback: (value: O[keyof O], key: keyof O) => boolean,
): { [K in keyof O]: R } {
	const output: { [K in keyof O]: R } = {} as { [K in keyof O]: R }
	for (const [key, value] of Object.entries(obj)) {
		if (callback(value, key as keyof O)) {
			output[key as keyof O] = value as R
		}
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

/**
 * Performs a structural merge between two values, maintaining referential equality
 * when possible. This function recursively compares and merges objects and arrays,
 * returning the original reference if no changes are detected.
 *
 * Key features:
 * - Preserves original object references when no changes are needed
 * - Handles both objects and arrays recursively
 * - Returns updated value directly if types don't match or values are primitives
 *
 * @param original - The original value to merge into
 * @param updated - The updated value to merge from
 * @returns Either the original reference (if no changes) or a new merged value
 */
export function structuralMerge<T>(original: T, updated: T): T {
	if (original === updated) return original
	if (!original || !updated) return updated
	if (typeof original !== 'object' || typeof updated !== 'object') return updated
	if (Array.isArray(original) !== Array.isArray(updated)) return updated

	if (Array.isArray(original) && Array.isArray(updated)) {
		if (original.length !== updated.length) return updated
		const result = [] as any[]
		let changed = false
		for (let i = 0; i < updated.length; i++) {
			const merged = structuralMerge(original[i], updated[i])
			result[i] = merged
			if (merged !== original[i]) changed = true
		}
		return (changed ? result : original) as T
	}

	const result = { ...original }
	let changed = false
	for (const key in updated) {
		const originalValue = original[key as keyof T]
		const updatedValue = updated[key as keyof T]
		const merged = structuralMerge(originalValue, updatedValue)
		result[key as keyof T] = merged
		if (merged !== originalValue) changed = true
	}

	return changed ? result : original
}

export function isEmpty(obj: unknown): boolean {
	if (!obj) return true
	if (typeof obj !== 'object') return false
	if (Array.isArray(obj)) return obj.length === 0
	return Object.keys(obj as object).length === 0
}

export type StrictUnion<A extends object, B extends object> = A | B extends object ? (keyof A & keyof B) extends never ? A | B
	: never
	: A | B

export type OptionalKeys<T extends object, Keys extends keyof T> = Omit<T, Keys> & Partial<Pick<T, Keys>>

export function shallowEquals<T extends object>(a: T, b: T): boolean {
	if (a === b) return true
	if (!a || !b) return false
	if (typeof a !== 'object' || typeof b !== 'object') return false

	const keysA = Object.keys(a)
	const keysB = Object.keys(b)

	if (keysA.length !== keysB.length) return false

	for (const key of keysA) {
		if (a[key as keyof T] !== b[key as keyof T]) return false
	}

	return true
}

export function destrNullable<T extends object>(obj: T | undefined) {
	if (obj) return obj
	return {} as T | { [k in keyof T]: undefined }
}
