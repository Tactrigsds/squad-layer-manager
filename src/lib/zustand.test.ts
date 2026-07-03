import { describe, expect, it, vi } from 'vitest'
import * as Zus from 'zustand'
import * as ZusUtils from './zustand'

type State = { user: { name: string; age: number }; count: number }

describe('getState', () => {
	it('reads store state', () => {
		const store = Zus.createStore<State>(() => ({ user: { name: 'a', age: 1 }, count: 0 }))
		expect(ZusUtils.getState(store)).toEqual({ user: { name: 'a', age: 1 }, count: 0 })
	})

	it('returns undefined for nullish sources', () => {
		expect(ZusUtils.getState(null)).toBeUndefined()
		expect(ZusUtils.getState(undefined)).toBeUndefined()
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
