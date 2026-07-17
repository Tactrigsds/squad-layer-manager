// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { RenderHookOptions } from '@testing-library/react'
import { act, cleanup, render as rtlRender, renderHook as rtlRenderHook, screen } from '@testing-library/react'
import * as React from 'react'
import * as Rx from 'rxjs'
import { afterEach, describe, expect, it } from 'vitest'
import * as Zus from 'zustand'
import * as ZusUtils from './zustand'

type State = { count: number; name: string }
const createStore = () => Zus.createStore<State>(() => ({ count: 0, name: 'a' }))

// useStore calls useQueries unconditionally, so even query-free reads need a provider in scope
const wrapper = ({ children }: { children: React.ReactNode }) => (
	<QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
)
function renderHook<R, P>(cb: (props: P) => R, opts?: Omit<RenderHookOptions<P>, 'wrapper'>) {
	return rtlRenderHook(cb, { wrapper, ...opts })
}
function render(ui: React.ReactElement) {
	return rtlRender(ui, { wrapper })
}

afterEach(cleanup)

describe('useStore', () => {
	it('reads a single store and re-renders on change', () => {
		const store = createStore()
		const { result } = renderHook(() => ZusUtils.useStore(store, (s: State) => s.count))
		expect(result.current).toBe(0)
		act(() => store.setState({ count: 1 }))
		expect(result.current).toBe(1)
	})

	it('reads multiple sources through a selector', () => {
		const a = createStore()
		const b = Zus.createStore(() => ({ suffix: '!' }))
		const { result } = renderHook(() => ZusUtils.useStore(a, b, (x: State, y: { suffix: string }) => x.name + y.suffix))
		expect(result.current).toBe('a!')
		act(() => a.setState({ name: 'z' }))
		expect(result.current).toBe('z!')
	})

	it('packs multiple sources into a tuple without a selector', () => {
		const a = createStore()
		const b = Zus.createStore(() => ({ other: 1 }))
		const { result } = renderHook(() => ZusUtils.useStore(a, b))
		expect(result.current).toEqual([{ count: 0, name: 'a' }, { other: 1 }])
	})

	it('keeps tuple identity stable when nothing changed', () => {
		const a = createStore()
		const b = Zus.createStore(() => ({ other: 1 }))
		const { result, rerender } = renderHook(() => ZusUtils.useStore(a, b))
		const first = result.current
		rerender()
		expect(result.current).toBe(first)
	})

	it('reads nullish inputs as undefined', () => {
		const store = createStore()
		const { result } = renderHook(() => ZusUtils.useStore(null, store, (x: undefined, y: State) => [x, y.count]))
		expect(result.current).toEqual([undefined, 0])
	})

	// the observable path is duck-typed on getValue/pipe, which a BehaviorSubject satisfies
	it('reads an observable source and re-renders on emission', () => {
		const subject = new Rx.BehaviorSubject({ n: 1 })
		const { result } = renderHook(() => ZusUtils.useStore(subject as any, (s: { n: number }) => s.n))
		expect(result.current).toBe(1)
		act(() => subject.next({ n: 2 }))
		expect(result.current).toBe(2)
	})

	it('mixes an observable with a store', () => {
		const store = createStore()
		const subject = new Rx.BehaviorSubject({ n: 10 })
		const { result } = renderHook(() => ZusUtils.useStore(store, subject as any, (s: State, o: { n: number }) => s.count + o.n))
		expect(result.current).toBe(10)
		act(() => subject.next({ n: 20 }))
		expect(result.current).toBe(20)
		act(() => store.setState({ count: 5 }))
		expect(result.current).toBe(25)
	})

	// the regression that motivates useSyncExternalStore: a selector closing over a prop must recompute when
	// that prop changes, even though no store emitted and no query data moved
	it('recomputes when the selector closes over a changed prop', () => {
		const store = Zus.createStore<{ items: Record<string, string> }>(() => ({ items: { a: 'apple', b: 'banana' } }))
		const { result, rerender } = renderHook(
			({ id }: { id: string }) => ZusUtils.useStore(store, (s: { items: Record<string, string> }) => s.items[id]),
			{ initialProps: { id: 'a' } },
		)
		expect(result.current).toBe('apple')
		rerender({ id: 'b' })
		expect(result.current).toBe('banana')
	})

	it('does not miss a store emission between render and subscription', () => {
		const store = createStore()
		// a component that mutates the store while rendering, i.e. before effects run
		function Probe() {
			const count = ZusUtils.useStore(store, (s: State) => s.count)
			const done = React.useRef(false)
			if (!done.current) {
				done.current = true
				store.setState({ count: 42 })
			}
			return <span data-testid="v">{count}</span>
		}
		render(<Probe />)
		expect(screen.getByTestId('v').textContent).toBe('42')
	})

	// an uncached getSnapshot makes useSyncExternalStore spin, and an inline selector returning a fresh object
	// every render is the shape most likely to trigger it
	it('does not loop or re-render spuriously with an inline object-returning selector', () => {
		const store = createStore()
		let renders = 0
		const { rerender } = renderHook(() => {
			renders++
			return ZusUtils.useStore(store, (s: State) => ({ count: s.count }))
		})
		expect(renders).toBe(1)
		rerender()
		expect(renders).toBe(2)
		// a store change the selector's output is insensitive to still shouldn't wedge anything
		act(() => store.setState({ name: 'zzz' }))
		expect(renders).toBeLessThanOrEqual(3)
	})

	it('does not re-render when an unrelated slice changes and the selector output is unchanged', () => {
		const store = createStore()
		let renders = 0
		renderHook(() => {
			renders++
			return ZusUtils.useStore(store, (s: State) => s.count)
		})
		expect(renders).toBe(1)
		act(() => store.setState({ name: 'other' }))
		expect(renders).toBe(1)
	})

	it('works under StrictMode double-rendering', () => {
		const store = createStore()
		const strictWrapper = ({ children }: { children: React.ReactNode }) => (
			<React.StrictMode>
				<QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
			</React.StrictMode>
		)
		const { result } = rtlRenderHook(() => ZusUtils.useStore(store, (s: State) => s.count), { wrapper: strictWrapper })
		expect(result.current).toBe(0)
		act(() => store.setState({ count: 3 }))
		expect(result.current).toBe(3)
	})

	it('reads query sources and re-renders when their data arrives', async () => {
		const store = createStore()
		const query = { queryKey: ['thing'], queryFn: async () => ({ n: 7 }) } as any
		const { result } = renderHook(() => ZusUtils.useStore(store, query, (s: State, q: { n: number } | undefined) => s.count + (q?.n ?? 0)))
		expect(result.current).toBe(0)
		await act(async () => {
			await new Promise(r => setTimeout(r, 10))
		})
		expect(result.current).toBe(7)
	})

	it('unsubscribes on unmount', () => {
		const store = createStore()
		const { unmount } = renderHook(() => ZusUtils.useStore(store, (s: State) => s.count))
		expect((store as any).getState()).toBeDefined()
		unmount()
		// no throw / no update after unmount
		act(() => store.setState({ count: 9 }))
	})
})
