export function reverseMapping<T extends { [key: string]: string }>(obj: T) {
	//@ts-expect-error it works
	const reversed: { [key in T[keyof T]]: keyof T } = {}
	for (const key in obj) {
		reversed[obj[key]] = key
	}
	return reversed
}
