import * as Gen from '@/lib/generator'
import * as Obj from '@/lib/object'
import * as ReactUtils from '@/lib/react'
import * as ZusUtils from '@/lib/zustand'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'

type FrameId = symbol
export type RawInstanceKey<Props extends { [key: string]: any } = object> = Readonly<{ frameId: FrameId } & Props>

// const KEYRING = Symbol('KEYRING')
// export function createKeyring<Keys extends { [key: string]: RawInstanceKey }>(keys: Keys) {
// 	return { ...keys, [KEYRING]: true } satisfies RawKeyring<Keys>
// }
// export type RawKeyring<Keys extends { [key: string]: RawInstanceKey } = { [key: string]: RawInstanceKey }> = Keys & { [KEYRING]: true }

export type KeyCollection<FT extends { [key: string]: FrameTypes } = { [key: string]: FrameTypes }> = {
	[k in keyof FT]: k extends keyof FT ? InstanceKey<FT[k]>
		: never
}

export type InstanceKey<T extends FrameTypes> = RawInstanceKey & Readonly<{ _: T }> // for inference

// export type Keyring<Keys extends KeyCollection> = Keys & { [KEYRING]: true }

export const DELETE_PROP = Symbol('DELETE')
export type DELETE_PROP = typeof DELETE_PROP
export type FrameTypes = {
	// data that can be used to retrieve a specific instance of the frame
	key: RawInstanceKey

	input: NonNullable<object>

	// WIP
	deps?: KeyCollection

	// The state once the frame has been initialized
	state: NonNullable<object>
}

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
	name: string
	id: FrameId
	createKey: (frameId: FrameId, input: T['input']) => T['key']
	setup(args: SetupArgs<T['input'], T['state'], StateWithDeps<T>>): void
	beforeTeardown?: (state: StateWithDeps<T>) => void
	canInitialize?: (input: T['input']) => boolean
	checkInputChanged: typeof Obj.shallowEquals
	onInputChanged?: (newInput: T['input'], args: SetupArgs<T['input'], T['state'], StateWithDeps<T>>) => void
}

type FrameOps<T extends FrameTypes> = {
	name: string
	createKey: Frame<T>['createKey']
	setup: Frame<T>['setup']
	beforeTeardown?: Frame<T>['beforeTeardown']
	canInitialize?: Frame<T>['canInitialize']

	checkInputChanged?: Frame<T>['checkInputChanged']
	onInputChanged?: Frame<T>['onInputChanged']
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
		this.frameInstances.delete(directKey)
		instance?.sub.unsubscribe()
		instance.update$.complete()
	}

	teardown(key: RawInstanceKey) {
		this.keys.delete(key)
		this.registry.unregister(key)
		const entry = Gen.find(this.frameInstances.entries(), ([k]) => Obj.deepEqual(k, key))
		if (!entry) return
		const [directKey, instance] = entry
		this.frameInstances.delete(directKey)
		instance?.sub.unsubscribe()
		instance.update$.complete()
	}

	createFrame<Types extends FrameTypes>(
		opts: FrameOps<Types>,
	) {
		const id = Symbol(opts.name)
		const frame: Frame<Types> = {
			id,
			canInitialize: opts.canInitialize ?? (() => true),
			checkInputChanged: Obj.shallowEquals ?? opts.checkInputChanged,
			...opts,
		}
		this.frameMap.set(id, frame)
		return frame
	}

	ensureSetup<T extends FrameTypes>(frameIdOrFrame: FrameId | Frame<T>, input: T['input'], depKeys?: T['deps']): InstanceKey<T> {
		const frame = typeof frameIdOrFrame === 'symbol' ? this.frameMap.get(frameIdOrFrame) : frameIdOrFrame
		const frameId = frame?.id ?? frameIdOrFrame as FrameId
		if (!frame) throw new Error(`Frame ${frameId.toString()} not found`)
		let depInstances: { [name: string]: FrameInstance } | undefined
		if (depKeys) {
			depInstances = {}
			for (const [name, key] of Object.entries(depKeys)) {
				const entry = Gen.find(this.frameInstances.entries(), ([k]) => Obj.deepEqual(k, key))
				if (!entry) {
					throw new Error(`Dependency ${key} not found`)
				}
				depInstances[name] = entry[1]
			}
		}
		const key = frame.createKey(frameId, input)
		const entry = Gen.find(this.frameInstances.entries(), ([k]) => Obj.deepEqual(key, k))
		let directKey: DirectInstanceKey
		let instance: FrameInstance
		if (!entry) {
			if (!frame.canInitialize?.(input)) throw new Error(`Frame ${frame.toString()} cannot initialize with input ${input}`)
			directKey = frame.createKey(frameId, input)
			const writeStore = Zus.createStore(() => ({}))
			instance = {
				frameId,
				input,
				refCount: 0,
				writeStore: writeStore,
				readStore: undefined!,
				sub: new Rx.Subscription(),
				update$: new Rx.Subject(),
				deps: depKeys,
				get: undefined!,
				set: undefined!,
				lastUsed: Date.now(),
			}

			if (depKeys) {
				instance.readStore = ZusUtils.deriveStores((get) => ({
					...get(this.frameInstances.get(directKey)!.writeStore),
					...Obj.map(depKeys, (key) => get(this.frameInstances.get(this.keys.get(key)!)!.writeStore)),
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
			if (frame.onInputChanged && !frame.checkInputChanged(input, instance.input)) {
				frame.onInputChanged(input, {
					input: instance.input,
					get: instance.get as ZusUtils.Getter<StateWithDeps<T>>,
					set: instance.set as ZusUtils.Setter<T['input']>,
					sub: instance.sub,
					update$: instance.update$,
				})
			}
		}
		this.keys.set(key, directKey)
		this.registry.register(key, directKey)
		instance.refCount++

		return key
	}

	getInstance<T extends FrameTypes>(key: InstanceKey<T>) {
		const directKey = this.keys.get(key)
		if (directKey) {
			const instance = this.frameInstances.get(directKey)
			if (instance) instance.lastUsed = Date.now()
			return instance
		}
		const entry = Gen.find(this.frameInstances.entries(), ([k]) => Obj.deepEqual(key, k))
		if (!entry) return
		this.keys.set(key, entry[0])
		this.registry.register(key, entry[0])
		entry[1].refCount++
		entry[1].lastUsed = Date.now()
		return entry[1]
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
		useFrameLifecycle,
		getFrameState,
		getFrameReaderStore,
	}

	function useFrameStore<T extends FrameTypes, O>(key: InstanceKey<T>, selector: (state: StateWithDeps<T>) => O): O {
		const instance = frameManager.getInstance(key)!
		return Zus.useStore(instance.readStore, selector as any)
	}

	// crudely just ensure the frame exists for the given input. for now just relies on FrameManagers GC behavior to clean up unused frames
	function useFrameLifecycle<T extends FrameTypes>(
		frameOrId: Frame<T> | FrameId,
		input: T['input'],
		deps?: T['deps'],
		equalityFn?: typeof Obj.shallowEquals<InstanceKey<T>>,
	) {
		return ReactUtils.useMemo<InstanceKey<T>>(
			() => {
				return frameManager.ensureSetup(frameOrId, input, deps)
			},
			[frameOrId, input],
			equalityFn,
		)
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

// only allows maxSize keys of a given permutation to exist. keys returned have LRU_ID attached, which is 0..maxSize
export function newLRUKeyCreator<K extends RawInstanceKey, I extends FrameTypes['input']>(
	manager: FrameManager,
	maxSize: number,
	createKeyInner: (frameId: string, input: I) => K = (frameId) => ({ frameId }) as unknown as K,
): (frameId: string, input: I) => K & { [LRU_ID]: number } {
	const LRU_ID = Symbol('LRU')
	return (frameId, input) => {
		const newInnerKey = createKeyInner(frameId, input)
		let lastUsedInstance: FrameInstance | undefined
		let lastUsedId: number = -1
		let numAllocated = 0
		for (const [directKey, instance] of manager.frameInstances.entries()) {
			const { [LRU_ID]: lruId, ...innerKey } = directKey as K & { [LRU_ID]: number }
			if (!Obj.deepEqual(newInnerKey, innerKey)) continue
			if (lruId === undefined) continue
			numAllocated++
			if (!lastUsedInstance || instance.lastUsed > lastUsedInstance.lastUsed) {
				lastUsedInstance = instance
				lastUsedId = lruId
			}
		}

		if (numAllocated >= maxSize) {
			return { ...newInnerKey, [LRU_ID]: lastUsedId }
		}
		return { ...newInnerKey, [LRU_ID]: numAllocated }
	}
}
