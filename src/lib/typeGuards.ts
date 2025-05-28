export function assertNever(value: never): never {
	throw new Error(`Unexpected value: ${value}`)
}
export function isNullOrUndef(value: unknown): value is null | undefined {
	return value === null || value === undefined
}
