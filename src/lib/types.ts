// represents some normalized data that is referenced by ids in some object
export type Parts<IncludedParts extends object> = { parts: IncludedParts }

export type RecursivePartial<T> = {
	[P in keyof T]?: T[P] extends (infer U)[] ? RecursivePartial<U>[] : T[P] extends object | undefined ? RecursivePartial<T[P]> : T[P]
}

export type Deferred = (() => Promise<void> | void)[]

export function resToNullable<R extends { code: string }>(res: R) {
	if (res.code !== 'ok') return null
	return res as Extract<R, { code: 'ok' }>
}

export function resToOptional<R extends { code: string }>(res: R) {
	if (res.code !== 'ok') return undefined
	return res as Extract<R, { code: 'ok' }>
}

export type MapTuple<T extends readonly unknown[], U> = {
	[K in keyof T]: U
}

export type StrKeys<T extends object> = Extract<keyof T, string>

export type NumericKeys<T extends object> = Extract<keyof T, number>
