import * as React from 'react'

import * as Gen from '@/lib/generator-utils'
import * as Obj from '@/lib/object-utils'
import * as ReactUtils from '@/lib/react'
import * as Zus from '@/lib/zustand'
import type * as CS from '@/models/context-shared'

import * as Cleanup from './cleanup'
import * as Rx from './rxjs'

type FrameId = symbol
// default Props is the loose index-signature shape rather than `any` -- `{ frameId } & any` would collapse
// the whole key type to `any`, breaking type narrowing and inference on keys downstream
export type RawInstanceKey<Props extends { [key: string]: any } = { [key: string]: any }> = Readonly<{ frameId: FrameId } & Props>

// const KEYRING = Symbol('KEYRING')
// export function createKeyring<Keys extends { [key: string]: RawInstanceKey }>(keys: Keys) {
// 	return { ...keys, [KEYRING]: true } satisfies RawKeyring<Keys>
// }
// export type RawKeyring<Keys extends { [key: string]: RawInstanceKey } = { [key: string]: RawInstanceKey }> = Keys & { [KEYRING]: true }

export type KeyProp<FT extends FrameTypes> = {
	[k in FT['name']]: InstanceKey<FT>
}
export function toProp<T extends FrameTypes>(key: InstanceKey<T>) {
	const name = key.frameId.description?.replace(/^frame-/, '') as T['name']
	return { [name]: key } as KeyProp<T>
}
function createFrameId(frame: { name: string }) {
	return Symbol('frame-' + frame.name)
}

export type InstanceKey<T extends FrameTypes> = T['key'] & Readonly<{ _: T }> // for inference
export type InstanceKeyOfState<T extends NonNullable<object>> = InstanceKey<FrameTypes & { state: T }>

// export type Keyring<Keys extends KeyCollection> = Keys & { [KEYRING]: true }

export const DELETE_PROP = Symbol('DELETE')
export type DELETE_PROP = typeof DELETE_PROP
export type FrameTypes = {
	name: string
	// data that can be used to retrieve a specific instance of the frame
	key: RawInstanceKey

	input: NonNullable<object>

	// The state once the frame has been initialized
	state: NonNullable<object>
}
export type FrameTypesOfState<T extends NonNullable<object>> = FrameTypes & { state: T }
export type InputUpdater<T extends FrameTypes> = ((input: T['input']) => T['input']) | T['input']

export type SetupArgs<
	I extends FrameTypes['input'] = FrameTypes['input'],
	State extends FrameTypes['state'] = FrameTypes['state'],
	Readable extends FrameTypes['state'] = State,
> = {
	input: I
	// the instance's own key -- lets setup code call Actions/partial helpers that take keys
	key: InstanceKeyOfState<Readable>
	get: Zus.Getter<Readable>
	set: Zus.Setter<State>
	//                      current,  prev
	update$: Rx.Observable<[Readable, Readable]>
	// teardown tasks, run FILO. takes subscriptions, subjects, abort controllers and plain thunks directly
	cleanup: Cleanup.Tasks
	// aborted before cleanup runs. guard setup work that resumes after an await with `if (args.signal.aborted) return`
	signal: AbortSignal
}

export type Frame<T extends FrameTypes> = {
	readonly _?: T // for inference
	name: T['name']
	id: FrameId
	createKey: (frameId: FrameId, input: T['input']) => T['key']
	setup(args: SetupArgs<T['input'], T['state']>): void
	canInitialize?: (input: T['input']) => boolean
}

type FrameOps<T extends FrameTypes> = {
	name: T['name']
	createKey: Frame<T>['createKey']
	setup: Frame<T>['setup']
	canInitialize?: Frame<T>['canInitialize']
}

export type PartialType<T extends FrameTypes['state']> = FrameTypes & { state: T }
export type Partial<T extends FrameTypes['state']> = Frame<PartialType<T>>

type FrameInstance = {
	frameId: FrameId
	refCount: number
	store: Zus.StoreApi<FrameTypes['state']>
	get: Zus.Getter<FrameTypes['state']>
	set: Zus.Setter<FrameTypes>
	update$: Rx.Subject<any>
	cleanup: Cleanup.Tasks
	// every live listener registered through onBeforeRelease on any of this instance's keys, run first in dispose
	releaseListeners: Set<ReleaseListener>
	abort: AbortController
	input: FrameTypes['input']
	lastUsed: number
}

type DirectInstanceKey = RawInstanceKey

// a listener remembers the key it was registered on, so running it from either side (that key's release, or the
// instance's dispose) can remove it from the other side's set
type ReleaseListener = { key: RawInstanceKey; run: () => void }

export class FrameManager {
	constructor(private ctx: CS.Log) {}

	// there may be multiple keys for the same instance<. the inner key is always a "direct" unexposted reference
	private keys = new WeakMap<RawInstanceKey, DirectInstanceKey>()
	// only  direct instance keys in here
	frameInstances = new Map<DirectInstanceKey, FrameInstance>()

	private frameMap = new Map<symbol, Frame<any>>()
	private registry = new FinalizationRegistry<DirectInstanceKey>((directKey) => {
		this.cleanupReference(directKey)
	})
	private releaseListeners = new WeakMap<RawInstanceKey, Set<ReleaseListener>>()

	private runReleaseListeners(listeners: Iterable<ReleaseListener>, instance: FrameInstance | undefined) {
		for (const listener of [...listeners]) {
			this.releaseListeners.get(listener.key)?.delete(listener)
			instance?.releaseListeners.delete(listener)
			try {
				listener.run()
			} catch (err) {
				this.ctx.log.error(err, 'caught error in frame release listener')
			}
		}
	}

	// the key is about to stop resolving: its own listeners run now, before it is forgotten, whether or not the
	// instance behind it survives
	private releaseKey(key: RawInstanceKey) {
		const listeners = this.releaseListeners.get(key)
		if (!listeners?.size) return
		const directKey = this.keys.get(key)
		this.runReleaseListeners(listeners, directKey && this.frameInstances.get(directKey))
	}

	// release listeners go first, while the instance is still whole, so whatever registered them can let go of the
	// frame before any of it is torn down. Then the signal aborts so setup work waiting on an await bails before the
	// tasks it would touch are torn down, then the tasks run FILO. runCleanup is async and logs per-task failures
	// itself, so nothing here waits on it
	private dispose(instance: FrameInstance) {
		this.runReleaseListeners(instance.releaseListeners, instance)
		instance.abort.abort(new DOMException('frame torn down', 'AbortError'))
		instance.update$.complete()
		void Cleanup.runCleanup(this.ctx, instance.cleanup)
	}

	cleanupReference(directKey: DirectInstanceKey) {
		const instance = this.frameInstances.get(directKey)
		if (!instance) {
			return
		}
		if (instance.refCount > 1) {
			instance.refCount--
			return
		}
		this.dispose(instance)
		this.frameInstances.delete(directKey)
	}

	// Runs `listener` once, just before `key` stops resolving: when the key is dropped or torn down, even if other
	// keys keep the instance alive, and when the instance is disposed through some other key. Either way it runs
	// ahead of the instance's abort signal and cleanup tasks. A key someone else owns can be dropped from under a
	// borrower at any time, so anything rendering from a borrowed key registers here rather than trusting it.
	// Returns the unsubscribe, or undefined when the key already fails to resolve
	onBeforeRelease(key: RawInstanceKey, run: () => void): (() => void) | undefined {
		const directKey = this.keys.get(key)
		const instance = directKey && this.frameInstances.get(directKey)
		if (!instance) return
		const listener: ReleaseListener = { key, run }
		let forKey = this.releaseListeners.get(key)
		if (!forKey) {
			forKey = new Set()
			this.releaseListeners.set(key, forKey)
		}
		forKey.add(listener)
		instance.releaseListeners.add(listener)
		return () => {
			forKey.delete(listener)
			instance.releaseListeners.delete(listener)
		}
	}

	teardown(key: RawInstanceKey) {
		this.releaseKey(key)
		this.keys.delete(key)
		this.registry.unregister(key)
		const entry = Gen.find(this.frameInstances.entries(), ([k]) => Obj.deepEqual(k, key))
		if (!entry) return
		const [directKey, instance] = entry
		this.dispose(instance)
		this.frameInstances.delete(directKey)
	}

	// eagerly releases one key's reference to its instance; the instance is torn down only when this was the last
	// one (the same accounting the FinalizationRegistry applies lazily when a key is collected). Use this instead of
	// teardown() whenever other systems might hold references to the same instance.
	dropKey(key: RawInstanceKey) {
		this.releaseKey(key)
		const directKey = this.keys.get(key)
		this.keys.delete(key)
		this.registry.unregister(key)
		if (!directKey) return
		this.cleanupReference(directKey)
	}

	createFrame<Types extends FrameTypes>(opts: FrameOps<Types>) {
		const id = createFrameId(opts)
		const frame: Frame<Types> = {
			id,
			canInitialize: opts.canInitialize ?? (() => true),
			...opts,
		}
		this.frameMap.set(id, frame)
		return frame
	}

	ensureSetup<T extends FrameTypes>(frameIdOrFrame: FrameId | Frame<T>, input: T['input']): InstanceKey<T> {
		const frame = typeof frameIdOrFrame === 'symbol' ? this.frameMap.get(frameIdOrFrame) : frameIdOrFrame
		const frameId = frame?.id ?? (frameIdOrFrame as FrameId)
		if (!frame) throw new Error(`Frame ${frameId.toString()} not found`)
		const key = frame.createKey(frameId, input)
		const entry = Gen.find(this.frameInstances.entries(), ([k]) => Obj.deepEqual(key, k))
		let directKey: DirectInstanceKey
		let instance: FrameInstance
		if (!entry) {
			if (!frame.canInitialize?.(input)) throw new Error(`Frame cannot initialize with input ${JSON.stringify(input)}`)
			directKey = frame.createKey(frameId, input)
			instance = {
				frameId,
				input: input,
				refCount: 0,
				store: Zus.createStore(() => ({})),
				cleanup: [],
				releaseListeners: new Set(),
				abort: new AbortController(),
				update$: new Rx.Subject(),
				get: undefined!,
				set: undefined!,
				lastUsed: Date.now(),
			}

			// instance.update$ = subject.pipe(Rx.tap({ next: () => instance.lastUsed = Date.now() }))
			// pushed first, so FILO tears it down last: every partial's subscription unwinds while updates still flow
			instance.cleanup.push(Zus.toObservable(instance.store).subscribe(instance.update$))
			instance.get = () => this.frameInstances.get(directKey)!.store.getState()
			instance.set = (update) => this.frameInstances.get(directKey)!.store.setState(update)
			this.frameInstances.set(directKey, instance)
			// register before setup so key-based access (e.g. Actions) works from within setup itself
			this.keys.set(directKey, directKey)

			// `update$` is already live at this point, so a partial's init that subscribes to it sees every LATER
			// partial's `set`, and frame-level fields read as undefined until the frame's own `args.set` has run.
			// Ordering inside setup() is therefore load-bearing: set the frame's own state first, then init partials.

			frame.setup({
				get: instance.get as any,
				set: instance.set,
				input: instance.input,
				cleanup: instance.cleanup,
				signal: instance.abort.signal,
				update$: instance.update$,
				key: directKey as InstanceKeyOfState<T['state']>,
			})
		} else {
			;[directKey, instance] = entry
			instance.lastUsed = Date.now()
		}
		this.keys.set(key, directKey)
		// the key doubles as the unregister token so an eager dropKey/teardown can cancel the pending GC callback,
		// which would otherwise release the same reference a second time when the key is eventually collected
		this.registry.register(key, directKey, key)
		instance.refCount++

		return key
	}

	// will only resolve keys known to the frame manager
	getInstance<T extends FrameTypes>(key: InstanceKey<T>) {
		const directKey = this.keys.get(key)
		if (!directKey) return
		const instance = this.frameInstances.get(directKey)
		if (instance) instance.lastUsed = Date.now()
		return instance
	}

	getState<T extends FrameTypes>(key: InstanceKey<T>) {
		const instance = this.getInstance(key)
		if (!instance) return
		return instance.store.getState() as T['state']
	}
}

export function createFrameHelpers(frameManager: FrameManager) {
	return {
		useFrameLifecycle,
		useFrameTeardownOnUnmount,
	}

	// drops the component's reference to a frame when it unmounts, for component-provisioned instances (instances
	// handed in from elsewhere should be left to their owner; pass `enabled: false` for those). Without this, unused
	// instances are only reclaimed whenever the FinalizationRegistry gets around to them. Uses dropKey rather than
	// teardown so an instance shared with other systems survives. The drop is deferred to an idle callback and
	// cancelled on a same-key re-setup so StrictMode's simulated remount doesn't kill an instance the still-mounted
	// tree references.
	function useFrameTeardownOnUnmount(key: RawInstanceKey | undefined, enabled = true) {
		const ctl = React.useRef<{ pending: { key: RawInstanceKey; id: number } | null }>({ pending: null })
		React.useEffect(() => {
			if (!enabled || !key) return
			const c = ctl.current
			if (c.pending?.key === key) {
				cancelIdleCallback(c.pending.id)
				c.pending = null
			}
			return () => {
				const id = requestIdleCallback(() => {
					c.pending = null
					frameManager.dropKey(key)
				})
				c.pending = { key, id }
			}
		}, [key, enabled])
	}

	type FrameLifecycleOptions<T extends FrameTypes> = {
		input?: T['input']
		frameKey?: InstanceKey<T>
		equalityFn?: typeof Obj.shallowEquals<InstanceKey<T>>
	}

	// crudely just ensure the frame exists for the given input. for now just relies on FrameManagers GC behavior to clean up unused frames
	function useFrameLifecycle<T extends FrameTypes>(frameOrId: Frame<T> | FrameId, options: FrameLifecycleOptions<T>) {
		const frameKey = ReactUtils.useStableValue(
			(frameOrId, options) => {
				if (options.frameKey) return options.frameKey
				if (options.input) {
					return frameManager.ensureSetup(frameOrId, options.input)
				} else {
					throw new Error('Frame lifecycle options must include either input or frameKey')
				}
			},
			[frameOrId, options],
			{ equals: options.equalityFn },
		)

		return frameKey
	}
}
