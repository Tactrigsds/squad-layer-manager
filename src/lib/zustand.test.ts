import { QueryClient } from '@tanstack/react-query'
import * as Rx from 'rxjs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Zus from 'zustand'
import * as ZusUtils from './zustand'

type State = { user: { name: string; age: number }; count: number }

describe('getState', () => {
	const createStore = () => Zus.createStore<State>(() => ({ user: { name: 'a', age: 1 }, count: 0 }))

	it('reads store state', () => {
		const store = createStore()
		expect(ZusUtils.getState(store)).toEqual({ user: { name: 'a', age: 1 }, count: 0 })
	})

	it('returns undefined for nullish sources', () => {
		expect(ZusUtils.getState(null)).toBeUndefined()
		expect(ZusUtils.getState(undefined)).toBeUndefined()
	})

	it('packs multiple sources into a tuple without a selector', () => {
		const a = createStore()
		const b = Zus.createStore(() => ({ other: true }))
		expect(ZusUtils.getState(a, b)).toEqual([{ user: { name: 'a', age: 1 }, count: 0 }, { other: true }])
	})

	it('applies a selector across multiple sources', () => {
		const a = createStore()
		const b = Zus.createStore(() => ({ suffix: '!' }))
		const sel = (x: State, y: { suffix: string }) => x.user.name + y.suffix
		expect(ZusUtils.getState(a, b, sel)).toBe('a!')
	})

	it('reads nullish inputs as undefined in the multi-source form', () => {
		const store = createStore()
		expect(ZusUtils.getState(null, store, undefined)).toEqual([undefined, { user: { name: 'a', age: 1 }, count: 0 }, undefined])
		expect(ZusUtils.getState(null, store, (a: undefined, b: State) => [a, b.count])).toEqual([undefined, 0])
	})
})

describe('getState with query sources', () => {
	afterEach(() => ZusUtils.registerQueryClient(undefined as any))

	const queryOpts = <T>(key: string, fn: () => Promise<T>) => ({ queryKey: [key], queryFn: fn }) as any

	it('returns a promise for a query source and resolves its data', async () => {
		ZusUtils.registerQueryClient(new QueryClient())
		const result = ZusUtils.getState(queryOpts('user', async () => ({ name: 'from-query' })))
		expect(result).toBeInstanceOf(Promise)
		await expect(result).resolves.toEqual({ name: 'from-query' })
	})

	it('returns a promise when query and sync sources are mixed', async () => {
		ZusUtils.registerQueryClient(new QueryClient())
		const store = Zus.createStore<State>(() => ({ user: { name: 'a', age: 1 }, count: 0 }))
		const sel = (s: State, q: { n: number }) => s.count + q.n
		await expect(ZusUtils.getState(store, queryOpts('n', async () => ({ n: 5 })), sel)).resolves.toBe(5)
	})

	it('samples sync sources at resolution, not at call time', async () => {
		ZusUtils.registerQueryClient(new QueryClient())
		const store = Zus.createStore<State>(() => ({ user: { name: 'a', age: 1 }, count: 0 }))
		let release!: () => void
		const gate = new Promise<void>(res => release = res)

		const pending = ZusUtils.getState(
			store,
			queryOpts('gated', async () => {
				await gate
				return { n: 1 }
			}),
			(s: State, q: { n: number }) => s.count + q.n,
		)

		store.setState({ count: 100 })
		release()
		// 100 (the post-call value), not 0 -- the store is read when the selector actually computes
		await expect(pending).resolves.toBe(101)
	})

	it('rejects when the query rejects', async () => {
		ZusUtils.registerQueryClient(new QueryClient({ defaultOptions: { queries: { retry: false } } }))
		const failing = queryOpts('boom', () => Promise.reject(new Error('boom')))
		await expect(ZusUtils.getState(failing)).rejects.toThrow('boom')
	})

	it('throws a clear error when no query client is registered', () => {
		expect(() => ZusUtils.getState(queryOpts('x', async () => 1))).toThrow(/registerQueryClient/)
	})
})

describe('getState with frame keys', () => {
	const setupFrameKey = (store: Zus.StoreApi<any>) => {
		const key = { frameId: Symbol('frame') } as any
		ZusUtils.registerFrameKeyResolver(k => k === key ? { store, update$: new Rx.Subject() } : undefined)
		return key
	}
	afterEach(() => ZusUtils.registerFrameKeyResolver(() => undefined))

	it('resolves frame keys on the sync path', () => {
		const store = Zus.createStore<State>(() => ({ user: { name: 'a', age: 1 }, count: 7 }))
		expect(ZusUtils.getState(setupFrameKey(store), (s: State) => s.count)).toBe(7)
	})

	it('resolves frame keys on the async path', async () => {
		ZusUtils.registerQueryClient(new QueryClient())
		const store = Zus.createStore<State>(() => ({ user: { name: 'a', age: 1 }, count: 7 }))
		const key = setupFrameKey(store)
		const query = { queryKey: ['n'], queryFn: async () => ({ n: 3 }) } as any
		await expect(ZusUtils.getState(key, query, (s: State, q: { n: number }) => s.count + q.n)).resolves.toBe(10)
		ZusUtils.registerQueryClient(undefined as any)
	})

	it('rejects when the frame is torn down while the query is in flight', async () => {
		ZusUtils.registerQueryClient(new QueryClient())
		const store = Zus.createStore<State>(() => ({ user: { name: 'a', age: 1 }, count: 7 }))
		const key = setupFrameKey(store)
		const query = { queryKey: ['torn'], queryFn: async () => ({ n: 3 }) } as any

		const pending = ZusUtils.getState(key, query, (s: State, q: { n: number }) => s.count + q.n)
		ZusUtils.registerFrameKeyResolver(() => undefined)
		await expect(pending).rejects.toThrow(/Frame instance not found/)
		ZusUtils.registerQueryClient(undefined as any)
	})
})

describe('toPartialStore', () => {
	const createStore = () => Zus.createStore<State>(() => ({ user: { name: 'a', age: 1 }, count: 0 }))

	it('reads the slice', () => {
		const store = createStore()
		const partial = ZusUtils.toPartialStore(store, 'user')
		expect(partial.getState()).toEqual({ name: 'a', age: 1 })
		expect(partial.getInitialState()).toEqual({ name: 'a', age: 1 })
	})

	it('merges partial object updates into the slice', () => {
		const store = createStore()
		const partial = ZusUtils.toPartialStore(store, 'user')
		partial.setState({ age: 2 })
		expect(store.getState().user).toEqual({ name: 'a', age: 2 })
	})

	it('supports updater functions and replace', () => {
		const store = createStore()
		const partial = ZusUtils.toPartialStore(store, 'user')
		partial.setState((prev) => ({ age: prev.age + 1 }))
		expect(store.getState().user).toEqual({ name: 'a', age: 2 })
		partial.setState({ name: 'b', age: 3 }, true)
		expect(store.getState().user).toEqual({ name: 'b', age: 3 })
	})

	it('replaces non-object slices', () => {
		const store = createStore()
		const partial = ZusUtils.toPartialStore(store, 'count')
		partial.setState(5)
		expect(store.getState().count).toBe(5)
		partial.setState((prev) => prev + 1)
		expect(store.getState().count).toBe(6)
	})

	it('only notifies subscribers when the slice changes', () => {
		const store = createStore()
		const partial = ZusUtils.toPartialStore(store, 'user')
		const listener = vi.fn()
		const unsub = partial.subscribe(listener)

		store.setState({ count: 1 })
		expect(listener).not.toHaveBeenCalled()

		const nextUser = { name: 'b', age: 2 }
		store.setState({ user: nextUser })
		expect(listener).toHaveBeenCalledTimes(1)
		expect(listener).toHaveBeenCalledWith(nextUser, { name: 'a', age: 1 })

		unsub()
		store.setState({ user: { name: 'c', age: 3 } })
		expect(listener).toHaveBeenCalledTimes(1)
	})
})
