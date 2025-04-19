// represents some normalized data that is referenced by ids in some object
export type Parts<IncludedParts extends object> = { parts: IncludedParts }

export type RecursivePartial<T> = {
	[P in keyof T]?: T[P] extends (infer U)[] ? RecursivePartial<U>[] : T[P] extends object | undefined ? RecursivePartial<T[P]> : T[P]
}

export type Deferred = (() => Promise<void> | void)[]
