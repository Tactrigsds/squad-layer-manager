import * as ZusUtils from '@/lib/zustand'

import * as Im from 'immer'
import React from 'react'
import * as ReactDom from 'react-dom'
import * as Zus from 'zustand'
import { sleep } from './async'

export type GlobalStore<T extends FrameTypes> = Zus.StoreApi<T['globalState']>
type InstanceKey = NonNullable<any>

export const DELETE_PROP = Symbol('DELETE')
export type DELETE_PROP = typeof DELETE_PROP
type TeardownState<State extends object> = { [k in keyof State]: State[k] | DELETE_PROP }
export type FrameTypes<GlobalState extends NonNullable<object> = NonNullable<object>> = {
	// data that can be used to retrieve a specific instance of the frame
	key: InstanceKey

	// superset of key which can initialize an instance of the frame
	input: NonNullable<object>

	// The state once the frame has been initialized
	state: NonNullable<object>

	// the state that's expected to exist regardless of the state of the frame
	globalState: GlobalState

	// the state that's expected to exist before the frame is initialized
	startingState: GlobalState
}

export type Frame<
	T extends FrameTypes,
> = {
	store: GlobalStore<T>

	exists(state: T['globalState'], key: T['key']): boolean
	initialStateExists(state: T['globalState'], key: T['key'] | T['input']): boolean
	setup(key: T['key'], input: T['input'], store: Zus.StoreApi<T['state']>, startingState: T['startingState']): T['state']
	teardown(state: T['state'], key: T['key'], setter: ZusUtils.Setter<TeardownState<T['state']>>): void
	keysEqual(key1: T['key'], key2: T['key']): boolean

	// optionally provide the props that this frame is interested in. might help with performance optimizations
	relevantProps?: keyof T['state']
}

type FrameOps<T extends FrameTypes> = {
	store: GlobalStore<T>

	exists: Frame<T>['exists']
	initialStateExists?: Frame<T>['initialStateExists']
	setup: Frame<T>['setup']
	teardown: Frame<T>['teardown']
	keysEqual: Frame<T>['keysEqual']
}

// selects some arbitrary state from the frame given that it exists
export type Selector<T extends FrameTypes, Out> = (state: T['state'], key: T['key']) => Out

export function create<Types extends FrameTypes>(
	opts: FrameOps<Types>,
) {
	const initialStateExists = opts.initialStateExists ?? (() => true)
	return {
		...opts,
		initialStateExists,
	}
}

export function existingFrameStore<T extends FrameTypes>(
	frame: Frame<T>,
	key: T['key'],
) {
	if (!frame.exists(frame.store.getState(), key)) throw new Error(`Frame with key ${JSON.stringify(key)} does not exist`)
	return frame.store
}
export function useFrameState<T extends FrameTypes, Out>(
	frame: Frame<T>,
	key: T['key'],
	selector: Selector<T, Out>,
) {
	const store = frame.store
	Zus.useStore(store, (state) => {
		if (!frame.exists(state, key)) return null
		return selector(state, key)
	})
}

export function useFrameExists<T extends FrameTypes>(
	frame: Frame<T>,
	key: T['key'],
) {
	const store = frame.store
	return Zus.useStore(store, state => frame.exists(state, key))
}

export function useExistingFrameState<T extends FrameTypes, Out>(
	frame: Frame<T>,
	key: T['key'],
	selector: Selector<T, Out>,
) {
	const store = frame.store
	const [exists, selected] = Zus.useStore(
		store,
		ZusUtils.useShallow(state => {
			const existing = frame.exists(state, key)
			return [existing, existing ? selector(state, key) : null]
		}),
	)
	if (!exists) {
		debugger
		throw new Error(`Frame with key ${JSON.stringify(key)} does not exist`)
	}
	return selected as Out
}

export function useFrameLifecycle<T extends FrameTypes>(
	frame: Frame<T>,
	key: T['key'],
	opts?: {
		teardownDelay?: number | false
	},
) {
	const [state, _setState] = React.useState(false)
	const paramsRef = React.useRef({ frame, key, opts })

	React.useEffect(() => {
		const {
			frame,
			key,
		} = paramsRef.current

		return () => {
			ensureTeardown(frame, key)
		}
	}, [])

	const buildActions = (input: T['input']) => {
		const setState: React.Dispatch<React.SetStateAction<boolean>> = (update) => {
			let newState!: boolean
			_setState(prevState => {
				newState = typeof update === 'function' ? update(prevState) : update
				return newState
			})
			if (newState) {
				ensureSetup(frame, key, input)
			} else {
				if (opts?.teardownDelay !== false) {
					sleep(opts?.teardownDelay ?? 0).then(() => {
						ensureTeardown(frame, key)
					})
				}
				return null
			}
			return setup(frame, key, input)
		}

		const prefetch = () => {
			ensureSetup(frame, key, input)
		}

		return { setState, prefetch }
	}

	return [state, buildActions] as const
}

// type MappedFrameInstance<T extends FrameTypes> = [T['key'], Frame<T>]
// export function useFrameSelect<Mapping extends Record<string, FrameTypes>>(
// 	store: GlobalStore<Mapping[keyof Mapping]>,
// 	mapping: { [k in keyof Mapping]: [Mapping[k]['key'], Frame<Mapping[k]>] },
// ) {
// 	const [active, _setActive] = React.useState<keyof Mapping | null>(null)

// 	const setActive<K extends (keyof Mapping)|null>(mappingKey: K, input: K extends keyof Mapping ? Mapping[K]['input'] : null) => {
// 		if (mappingKey === null && active == null) return null
// 		if (active) {
// 			const [key, frame] = mapping[active]
// 			teardown(store, frame, key)
// 			return null
// 		}
// 		if (mappingKey !== null && input !== null) {
//   		const [key,frame] = mapping[mappingKey]
//   		return setup(store, frame, key, input)
// 		}
// 	}

// 	return [active,setActive] as const
// }

export function setup<T extends FrameTypes>(frame: Frame<T>, key: T['key'], input: T['input']) {
	const store = frame.store
	console.debug('setup', key)
	const globalState = store.getState()
	if (!frame.initialStateExists(globalState, input)) {
		debugger
		throw new Error(`Starting State for frame with key ${JSON.stringify(key)} does not exist on setup`)
	}
	return frame.setup(key, input, store, globalState)
}

export function ensureSetup<T extends FrameTypes>(frame: Frame<T>, key: T['key'], input: T['input']) {
	const store = frame.store
	const globalState = store.getState()
	if (!frame.initialStateExists(globalState, input)) {
		debugger
		throw new Error(`Starting State for frame with key ${JSON.stringify(key)} does not exist on setup`)
	}
	if (frame.exists(globalState, key)) {
		return null
	}
	return frame.setup(key, input, store, globalState)
}

export function teardown<T extends FrameTypes>(frame: Frame<T>, key: T['key']) {
	console.debug('teardown', key)
	const store = frame.store
	const globalState = store.getState()
	if (!frame.exists(globalState, key)) {
		debugger
		throw new Error(`Frame with key ${JSON.stringify(key)} does not exist on teardown`)
	}

	frame.teardown(globalState, key, (update) => store.setState(update))
}

export function ensureTeardown<T extends FrameTypes>(frame: Frame<T>, key: T['key']) {
	const store = frame.store
	const globalState = store.getState()
	if (!frame.exists(globalState, key)) {
		return
	}
	frame.teardown(globalState, key, (update) => store.setState(update))
}
