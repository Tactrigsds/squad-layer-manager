export function assertNever(value: never): never {
	throw new Error(`Unexpected value: ${value}`)
}
export function nullOrUndefined(value: unknown): value is null | undefined {
	return value === null || value === undefined
}
