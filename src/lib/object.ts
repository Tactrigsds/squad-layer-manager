export function reverseMapping<T extends { [key: string]: string }>(obj: T) {
	//@ts-expect-error it works
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
