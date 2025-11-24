import * as Gen from '@/lib/generator'
import * as Obj from '@/lib/object'
import * as ReactUtils from '@/lib/react'
import * as ZusUtils from '@/lib/zustand'
import React from 'react'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'

type FrameId = symbol
export type RawInstanceKey<Props extends { [key: string]: any } = any> = Readonly<{ frameId: FrameId } & Props>

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

export type KeyCollection<FT extends { [key: string]: FrameTypes } = { [key: string]: FrameTypes }> = {
	[k in keyof FT as FT[k]['name']]: k extends keyof FT ? InstanceKey<FT[k]>
		: never
}

export type InstanceKey<T extends FrameTypes> = T['key'] & Readonly<{ _: T }> // for inference

// export type Keyring<Keys extends KeyCollection> = Keys & { [KEYRING]: true }

export const DELETE_PROP = Symbol('DELETE')
export type DELETE_PROP = typeof DELETE_PROP
export type FrameTypes = {
	name: string
	// data that can be used to retrieve a specific instance of the frame
	key: RawInstanceKey

	input: NonNullable<object>

	// WIP
	deps?: KeyCollection

	// The state once the frame has been initialized
	state: NonNullable<object>
}
export type InputUpdater<T extends FrameTypes> = ((input: T['input']) => T['input']) | T['input']

type FramesOfKeys<KC extends KeyCollection> = {
	[k in keyof KC]: KC[k]['_']['deps'] extends KeyCollection ? FramesOfKeys<KC[k]['_']['deps']> : object
}

type StateWithDeps<T extends FrameTypes> =
	& T['state']
	& (T['deps'] extends KeyCollection ? FramesOfKeys<T['deps']>[keyof T['deps']] : object)

export type SetupArgs<
	I extends FrameTypes['input'] = FrameTypes['input'],
	State extends FrameTypes['state'] = FrameTypes['state'],
	Readable extends FrameTypes['state'] = FrameTypes['state'],
> = {
	input: I
	get: ZusUtils.Getter<Readable>
	set: ZusUtils.Setter<State>
	//                      current,  prev
	update$: Rx.Observable<[Readable, Readable]>
	sub: Rx.Subscription
}

export type Frame<
	T extends FrameTypes,
> = {
	name: T['name']
	id: FrameId
	createKey: (frameId: FrameId, input: T['input']) => T['key']
	setup(args: SetupArgs<T['input'], T['state'], StateWithDeps<T>>): void
	beforeTeardown?: (state: StateWithDeps<T>) => void
	canInitialize?: (input: T['input']) => boolean
}

type FrameOps<T extends FrameTypes> = {
	name: T['name']
	createKey: Frame<T>['createKey']
	setup: Frame<T>['setup']
	beforeTeardown?: Frame<T>['beforeTeardown']
	canInitialize?: Frame<T>['canInitialize']
}

export type PartialType<T extends FrameTypes['state']> = FrameTypes & { state: T }
export type Partial<T extends FrameTypes['state']> = Frame<PartialType<T>>

type FrameInstance = {
	frameId: FrameId
	refCount: number
	writeStore: Zus.StoreApi<FrameTypes['state']>
	readStore: Zus.StoreApi<StateWithDeps<FrameTypes>>
	get: ZusUtils.Getter<StateWithDeps<FrameTypes>>
	set: ZusUtils.Setter<FrameTypes>
	update$: Rx.Subject<any>
	sub: Rx.Subscription
	input: FrameTypes['input']
	deps?: KeyCollection
	lastUsed: number
}

type DirectInstanceKey = RawInstanceKey

export class FrameManager {
	// there may be multiple keys for the same instance<. the inner key is always a "direct" unexposted reference
	private keys = new WeakMap<RawInstanceKey, DirectInstanceKey>()
	// only  direct instance keys in here
	frameInstances = new Map<DirectInstanceKey, FrameInstance>()

	private frameMap = new Map<symbol, Frame<any>>()
	private registry = new FinalizationRegistry<DirectInstanceKey>((directKey) => {
		this.cleanupReference(directKey)
	})

	cleanupReference(directKey: DirectInstanceKey) {
		const instance = this.frameInstances.get(directKey)
		if (!instance) {
			return
		}
		if (instance.refCount > 1) {
			instance.refCount--
			return
		}
		instance.update$.complete()
		instance.sub.unsubscribe()
		this.frameInstances.delete(directKey)
	}

	teardown(key: RawInstanceKey) {
		this.keys.delete(key)
		this.registry.unregister(key)
		const entry = Gen.find(this.frameInstances.entries(), ([k]) => Obj.deepEqual(k, key))
		if (!entry) return
		const [directKey, instance] = entry
		instance.update$.complete()
		instance?.sub.unsubscribe()
		this.frameInstances.delete(directKey)
	}

	createFrame<Types extends FrameTypes>(
		opts: FrameOps<Types>,
	) {
		const id = createFrameId(opts)
		const frame: Frame<Types> = {
			id,
			canInitialize: opts.canInitialize ?? (() => true),
			...opts,
		}
		this.frameMap.set(id, frame)
		return frame
	}

	ensureSetup<T extends FrameTypes>(
		frameIdOrFrame: FrameId | Frame<T>,
		input: T['input'],
		opts?: { depKeys?: T['deps'] },
	): InstanceKey<T> {
		const frame = typeof frameIdOrFrame === 'symbol' ? this.frameMap.get(frameIdOrFrame) : frameIdOrFrame
		const frameId = frame?.id ?? frameIdOrFrame as FrameId
		if (!frame) throw new Error(`Frame ${frameId.toString()} not found`)
		let depInstances: { [name: string]: FrameInstance } | undefined
		if (opts?.depKeys) {
			depInstances = {}
			for (const [name, key] of Object.entries(opts.depKeys)) {
				const entry = Gen.find(this.frameInstances.entries(), ([k]) => Obj.deepEqual(k, key))
				if (!entry) {
					throw new Error(`Dependency ${JSON.stringify(key)} not found`)
				}
				depInstances[name] = entry[1]
			}
		}
		const key = frame.createKey(frameId, input)
		const entry = Gen.find(this.frameInstances.entries(), ([k]) => Obj.deepEqual(key, k))
		let directKey: DirectInstanceKey
		let instance: FrameInstance
		if (!entry) {
			if (!frame.canInitialize?.(input)) throw new Error(`Frame cannot initialize with input ${JSON.stringify(input)}`)
			directKey = frame.createKey(frameId, input)
			const writeStore = Zus.createStore(() => ({}))
			instance = {
				frameId,
				input: input,
				refCount: 0,
				writeStore: writeStore,
				readStore: undefined!,
				sub: new Rx.Subscription(),
				update$: new Rx.Subject(),
				deps: opts?.depKeys,
				get: undefined!,
				set: undefined!,
				lastUsed: Date.now(),
			}

			if (opts?.depKeys) {
				instance.readStore = ZusUtils.deriveStores((get) => ({
					...get(this.frameInstances.get(directKey)!.writeStore),
					...Obj.map(opts!.depKeys!, (key) => get(this.frameInstances.get(this.keys.get(key)!)!.writeStore)),
				}))
			} else {
				instance.readStore = instance.writeStore
			}

			// instance.update$ = subject.pipe(Rx.tap({ next: () => instance.lastUsed = Date.now() }))
			instance.sub.add(ZusUtils.toObservable(instance.readStore).subscribe(instance.update$))
			instance.get = () => this.frameInstances.get(directKey)!.readStore.getState()
			instance.set = (update) => this.frameInstances.get(directKey)!.writeStore.setState(update)
			this.frameInstances.set(directKey, instance)

			frame.setup({
				get: instance.get as any,
				set: instance.set,
				input: instance.input,
				sub: instance.sub,
				update$: instance.update$,
			})
		} else {
			;[directKey, instance] = entry
			instance.lastUsed = Date.now()
		}
		this.keys.set(key, directKey)
		this.registry.register(key, directKey)
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
		return instance.readStore.getState() as StateWithDeps<T>
	}
}

export function createFrameHelpers(frameManager: FrameManager) {
	return {
		useFrameStore,
		useNullableFrameStore,
		useFrameLifecycle,
		getFrameState,
		getFrameReaderStore,
	}

	function useFrameStore<T extends FrameTypes, O>(key: InstanceKey<T>, selector: (state: StateWithDeps<T>) => O): O {
		const instance = frameManager.getInstance(key)!
		if (!instance) throw new Error(`Frame instance not found for key`)
		return Zus.useStore(instance.readStore, selector as any)
	}

	function useNullableFrameStore<T extends FrameTypes, O>(
		key: InstanceKey<T> | null | undefined,
		selector: (state: StateWithDeps<T> | null) => O,
	): O {
		const placeholderStoreRef = React.useRef<Zus.StoreApi<unknown>>(Zus.createStore(() => null))

		const store = key ? frameManager.getInstance(key)?.readStore ?? placeholderStoreRef.current : placeholderStoreRef.current
		return Zus.useStore(store, state => store === placeholderStoreRef.current ? selector(null) : selector(state as StateWithDeps<T>))
	}

	type FrameLifecycleOptions<T extends FrameTypes> = {
		input?: T['input']
		frameKey?: InstanceKey<T>
		deps?: T['deps']
		equalityFn?: typeof Obj.shallowEquals<InstanceKey<T>>
	}

	// crudely just ensure the frame exists for the given input. for now just relies on FrameManagers GC behavior to clean up unused frames
	function useFrameLifecycle<T extends FrameTypes>(
		frameOrId: Frame<T> | FrameId,
		options: FrameLifecycleOptions<T>,
	) {
		const frameKey = ReactUtils.useStableValue(
			(frameOrId, options) => {
				if (options.frameKey) return options.frameKey
				if (options.input) {
					return frameManager.ensureSetup(frameOrId, options.input, options.deps)
				} else {
					throw new Error('Frame lifecycle options must include either input or frameKey')
				}
			},
			[frameOrId, options],
			{ equals: options.equalityFn },
		)

		return frameKey
	}

	function getFrameState<T extends FrameTypes>(key: InstanceKey<T>) {
		const instance = frameManager.getInstance(key)!
		return instance.readStore.getState() as StateWithDeps<T>
	}

	function getFrameReaderStore<T extends FrameTypes>(key: InstanceKey<T>) {
		const instance = frameManager.getInstance(key)!
		return instance.readStore as Zus.StoreApi<StateWithDeps<T>>
	}
}
