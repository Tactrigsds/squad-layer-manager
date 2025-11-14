// TODO we should throw at the callsite instead, currently typescript gets confused with certain flow control like nested switch statements
export function assertNever(value: never): never {
	throw new Error(`Unexpected value: ${value}`)
}
export function isNullOrUndef(value: unknown): value is null | undefined {
	return value === null || value === undefined
}
