export function reverseMapping<T extends { [key: string]: string }>(obj: T) {
	// @ts-expect-error it works
	const reversed: { [key in T[keyof T]]: keyof T } = {}
	for (const key in obj) {
		reversed[obj[key]] = key
	}
	return reversed
}

export function deepClone<T>(obj: T) {
	return JSON.parse(JSON.stringify(obj)) as T
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
