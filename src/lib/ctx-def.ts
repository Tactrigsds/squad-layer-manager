/**
 * Contexts stay pure types. Alongside each one sits a `def`: a runtime value listing that context's
 * properties, from which merging, projection and collision checking are derived.
 *
 * See docs/architecture.md, "Context as duck-typed dependency injection".
 */
// The brand lives here rather than in context-shared, so that this module is a leaf. Every context
// module now holds defs, which are values, so a def module importing the brand's home and that home
// importing this back would be a genuine runtime cycle rather than a harmless type-only one.
export const CtxSymbol = Symbol('context')
export type Ctx = {
	[CtxSymbol]: true
}
export function init(): Ctx {
	return { [CtxSymbol]: true }
}
export function isCtx(ctx: any): ctx is Ctx {
	return ctx && ctx[CtxSymbol] === true
}

export type PropKey = PropertyKey

// phantom carrier: never present at runtime, holds every type-level fact about a def
declare const PH: unique symbol

type Meta = {
	type: unknown
	/** keys this def declares itself */
	own: PropKey
	/** own keys plus everything inherited via `extends` */
	all: PropKey
	/** keys explicitly acknowledged as colliding with another context */
	collides: PropKey
}

export type Def<M extends Meta = Meta> = {
	/** every key, own and inherited. Present at runtime -- this is what makes `select` possible */
	readonly keys: readonly PropKey[]
	readonly ownKeys: readonly PropKey[]
	readonly collisions: readonly PropKey[]
	readonly name: string
	readonly [PH]: M
}

export type AnyDef = Def<any>

// Internally this must be InferDef: a bare `infer<T>` in type-argument position parses as the
// `infer` operator. Re-exported below as `infer` for qualified use (`CD.infer<...>`), which is
// exactly how zod exposes `z.infer`.
export type InferDef<D extends AnyDef> = D[typeof PH]['type']
export type keysOf<D extends AnyDef> = D[typeof PH]['all']
export type ownKeysOf<D extends AnyDef> = D[typeof PH]['own']
export type collisionsOf<D extends AnyDef> = D[typeof PH]['collides']
export type { InferDef as infer }

type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (k: infer I) => void ? I : never

// ---------------------------------------------------------------- defCtx

type ErrMissing<K extends PropKey> = { __CTX_MISSING_KEYS__: K }
type ErrExtra<K extends PropKey> = { __CTX_KEY_NOT_IN_TYPE__: K }
type ErrDup<K extends PropKey> = { __CTX_DUPLICATE_KEY__: K }

type Dups<A extends readonly PropKey[], Seen extends PropKey = never> = A extends readonly [
	infer H extends PropKey,
	...infer R extends readonly PropKey[],
]
	? H extends Seen
		? H
		: Dups<R, Seen | H>
	: never

/** keys the def must account for: everything on T except the brand and anything inherited */
type Owed<T, Inherited extends PropKey> = Exclude<keyof T, typeof CtxSymbol | Inherited>

type CheckKeys<T, Inherited extends PropKey, K extends readonly PropKey[]> = (Exclude<Owed<T, Inherited>, K[number]> extends never
	? unknown
	: ErrMissing<Exclude<Owed<T, Inherited>, K[number]>>) &
	(Exclude<K[number], keyof T> extends never ? unknown : ErrExtra<Exclude<K[number], keyof T>>) &
	(Dups<K> extends never ? unknown : ErrDup<Dups<K>>)

export type DefOpts<T> = {
	name?: string
	/** defs this context is built on top of; their keys are inherited rather than re-declared */
	extends?: readonly AnyDef[]
	/** keys knowingly shared with another context. Suppresses the merge-time collision error */
	collisions?: readonly (keyof T)[]
}

type InheritedOf<O> = O extends { extends: readonly AnyDef[] } ? keysOf<O['extends'][number]> : never

/**
 * Curried because TypeScript has no partial type-argument inference: T must be given explicitly
 * while `keys` is inferred as a literal tuple.
 */
export function defCtx<T extends Ctx>() {
	return <const K extends readonly (keyof T)[], const O extends DefOpts<T> = {}>(
		keys: K & CheckKeys<T, InheritedOf<O>, K>,
		opts?: O,
	): Def<{
		type: T
		own: K[number]
		all: K[number] | InheritedOf<O>
		collides: O extends { collisions: readonly PropKey[] } ? O['collisions'][number] : never
	}> => {
		const inherited = (opts?.extends ?? []).flatMap((d) => d.keys)
		return {
			ownKeys: keys as readonly PropKey[],
			keys: [...new Set([...inherited, ...(keys as readonly PropKey[])])],
			collisions: (opts?.collisions ?? []) as readonly PropKey[],
			name: opts?.name ?? '<anon>',
		} as any
	}
}

// ---------------------------------------------------------------- merge

type DupOwn<Ds extends readonly AnyDef[], Seen extends PropKey = never, Acc extends PropKey = never> = Ds extends readonly [
	infer H extends AnyDef,
	...infer R extends readonly AnyDef[],
]
	? DupOwn<R, Seen | ownKeysOf<H>, Acc | Extract<ownKeysOf<H>, Seen>>
	: Acc

type ErrCollision<K extends PropKey> = { __CTX_UNDECLARED_COLLISION__: K }

/**
 * A duplicated own-key is acceptable only if EVERY def that owns it declares it in `collisions`.
 * Declaring on one side alone would leave the other side able to be surprised, which is the exact
 * failure this exists to prevent.
 */
type OwnersMissingDecl<Ds extends readonly AnyDef[], K extends PropKey> = Ds[number] extends infer D
	? D extends AnyDef
		? K extends ownKeysOf<D>
			? K extends collisionsOf<D>
				? never
				: K
			: never
		: never
	: never

type Unacknowledged<Ds extends readonly AnyDef[]> =
	DupOwn<Ds> extends infer K ? (K extends PropKey ? OwnersMissingDecl<Ds, K> : never) : never

type CheckMerge<Ds extends readonly AnyDef[]> = Unacknowledged<Ds> extends never ? unknown : ErrCollision<Unacknowledged<Ds>>

export function mergeDefs<const Ds extends readonly AnyDef[]>(
	defs: Ds & CheckMerge<Ds>,
	opts?: { name?: string },
): Def<{
	type: UnionToIntersection<InferDef<Ds[number]>>
	own: ownKeysOf<Ds[number]>
	all: keysOf<Ds[number]>
	collides: collisionsOf<Ds[number]>
}> {
	const list = defs as readonly AnyDef[]
	return {
		ownKeys: [...new Set(list.flatMap((d) => d.ownKeys))],
		keys: [...new Set(list.flatMap((d) => d.keys))],
		collisions: [...new Set(list.flatMap((d) => d.collisions))],
		name: opts?.name ?? list.map((d) => d.name).join('+'),
	} as any
}

// ---------------------------------------------------------------- select

/**
 * Build a reusable projector. Copies exactly the keys the given defs declare (plus the brand) out
 * of a wider ctx, so a handler closure carries precisely what it asked for and nothing else.
 */
export function select<const Ds extends readonly AnyDef[]>(
	defs: Ds & CheckMerge<Ds>,
): <S extends UnionToIntersection<InferDef<Ds[number]>>>(source: S) => UnionToIntersection<InferDef<Ds[number]>> {
	// key list resolved once, at module init, not per call
	const keys = [...new Set((defs as readonly AnyDef[]).flatMap((d) => d.keys))]
	return (source: any): any => {
		const out: any = { [CtxSymbol]: true }
		for (const k of keys) {
			// `in` rather than a null check: an optional-but-present key holding undefined must survive
			if (k in source) out[k] = source[k]
		}
		return out
	}
}
