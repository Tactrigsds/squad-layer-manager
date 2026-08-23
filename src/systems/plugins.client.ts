import * as React from 'react'

import * as ReactRx from '@/lib/react-rxjs'
import * as Rx from '@/lib/rxjs'
import * as Zus from '@/lib/zustand'
import type * as PLG from '@/models/plugins.models'
import * as RPC from '@/orpc.client'

// Client half of the plugin host: watches which plugins are active, loads their client entries, and
// holds what those entries register -- slot components, row decorations, rpc query stores. Anchors
// are a closed, typed set: a plugin renders only where the host has placed one.

export type ClientCtx<M extends PLG.Manifest<any> = PLG.Manifest> = {
	plugin: { id: PLG.PluginId; manifest: M }
}

export type ClientModule = { manifest: PLG.Manifest; setup: (ctx: ClientCtx<any>) => void }

export function definePluginClient<M extends PLG.Manifest<any>>(manifest: M, setupFn: (ctx: ClientCtx<M>) => void): ClientModule {
	return { manifest, setup: setupFn as ClientModule['setup'] }
}

export type InstalledClientPlugin = {
	manifest: PLG.Manifest
	client?: () => Promise<{ default: ClientModule }>
}

// ---- anchors ----

export type SlotAnchors = {
	'server-dashboard:alerts': { serverId: string }
}
export type SlotAnchorId = keyof SlotAnchors

// decorations contribute data, not markup: the host maps tints onto its own styling
export type Tint = 'info' | 'warn' | 'violation'
export type Decoration = { tint?: Tint; badge?: string; title?: string }
// what a host anchor renders: the plugin's decoration plus which registration produced it
export type DecorationEntry = Decoration & { regKey: string }
export type DecorationAnchors = {
	'match-history:row': { serverId: string; matchId: number }
}
export type DecorationAnchorId = keyof DecorationAnchors

// regKey is stable per registration, so React can key a slot or a decoration by its origin rather
// than its position: one plugin may register twice at the same anchor.
type SlotReg = { pluginId: string; regKey: string; component: React.FC<any> }
type DecorationReg = {
	pluginId: string
	regKey: string
	stores: (props: any) => Zus.AnyInput<any>[]
	select: (...args: any[]) => Decoration | null | undefined
}

// version bumps whenever the registration set changes; consumers re-subscribe off it
export const Store = Zus.createStore<{ plugins: PLG.RuntimeInfo[]; version: number }>(() => ({ plugins: [], version: 0 }))
const slotRegs = new Map<string, SlotReg[]>()
const decoRegs = new Map<string, DecorationReg[]>()
const undoByPlugin = new Map<string, (() => void)[]>()
const loadedPlugins = new Set<string>()
let installed: InstalledClientPlugin[] = []

let regCounter = 0
function nextRegKey(pluginId: string) {
	return `${pluginId}:${regCounter++}`
}

function bumpVersion() {
	Store.setState((s) => ({ ...s, version: s.version + 1 }))
}

function pushReg<T>(map: Map<string, T[]>, key: string, pluginId: string, reg: T) {
	const list = map.get(key) ?? []
	list.push(reg)
	map.set(key, list)
	const undos = undoByPlugin.get(pluginId) ?? []
	undos.push(() => {
		const current = map.get(key)
		const idx = current?.indexOf(reg) ?? -1
		if (current && idx >= 0) current.splice(idx, 1)
	})
	undoByPlugin.set(pluginId, undos)
}

export function registerSlot<A extends SlotAnchorId>(ctx: ClientCtx<any>, anchor: A, component: React.FC<SlotAnchors[A]>) {
	pushReg(slotRegs, anchor, ctx.plugin.id, { pluginId: ctx.plugin.id, regKey: nextRegKey(ctx.plugin.id), component })
	bumpVersion()
}

export function registerDecoration<A extends DecorationAnchorId>(
	ctx: ClientCtx<any>,
	anchor: A,
	reg: {
		stores: (props: DecorationAnchors[A]) => Zus.AnyInput<any>[]
		// called as select(...storeStates, props)
		select: (...args: any[]) => Decoration | null | undefined
	},
) {
	pushReg(decoRegs, anchor, ctx.plugin.id, { pluginId: ctx.plugin.id, regKey: nextRegKey(ctx.plugin.id), ...reg })
	bumpVersion()
}

export function getSlotRegs(anchor: SlotAnchorId): SlotReg[] {
	return slotRegs.get(anchor) ?? []
}

// ---- rpc query stores ----

// A keyed family of StateObservables over a plugin's server-registered watch stream (deep-equal
// args share an instance, via ReactRx.bind). Values are unwrapped; server-not-loaded and other
// error codes read as undefined so selectors stay total.
export function queryStore<Args extends unknown[], T = unknown>(
	ctx: ClientCtx<any>,
	name: string,
	keyFn: (...args: Args) => { serverId: string; input?: unknown },
): (...args: Args) => Zus.ValueObservable<T | undefined> {
	const [, family$] = ReactRx.bind(`plugins.${ctx.plugin.id}.${name}`, (...args: Args) => {
		const { serverId, input } = keyFn(...args)
		return RPC.observe(`plugins.rpcStream:${ctx.plugin.id}.${name}`, () =>
			RPC.orpc.plugins.rpcStream.call({ pluginId: ctx.plugin.id, name, serverId, input: input ?? {} }),
		).pipe(Rx.map((res) => (res && typeof res === 'object' && 'code' in res && res.code === 'ok' ? (res.data as T) : undefined)))
	})
	// Wrapped so getValue is total: a raw StateObservable throws NoSubscribersError before its first
	// subscriber and hands back a StatePromise before its first value, and consumers (selectors, the
	// decoration snapshot) read "no value yet" for both. Cached per underlying instance so deep-equal
	// args keep sharing one store.
	const safeCache = new WeakMap<object, Zus.ValueObservable<T | undefined>>()
	return (...args: Args) => {
		const obs = family$(...args)
		let safe = safeCache.get(obs)
		if (!safe) {
			safe = Object.assign(new Rx.Observable<T | undefined>((subscriber) => obs.subscribe(subscriber)), {
				getValue: (): T | undefined => {
					try {
						const v = obs.getValue()
						return isThenable(v) ? undefined : (v as T | undefined)
					} catch {
						return undefined
					}
				},
			})
			safeCache.set(obs, safe)
		}
		return safe
	}
}

function isThenable(v: unknown): boolean {
	return typeof (v as { then?: unknown } | null | undefined)?.then === 'function'
}

export async function call<T = unknown>(ctx: ClientCtx<any>, name: string, input?: unknown) {
	return (await RPC.orpc.plugins.rpcCall.call({ pluginId: ctx.plugin.id, name, input: input ?? {} })) as
		| { code: 'ok'; data: T }
		| { code: 'err:unknown-rpc' }
		| { code: 'err:invalid-input' }
}

// ---- decorations consumption ----

function subscribeInput(input: Zus.AnyInput<any>, onChange: () => void): () => void {
	const sub = (input as any).subscribe(onChange)
	return typeof sub === 'function' ? sub : () => sub.unsubscribe()
}

function readInput(input: Zus.AnyInput<any>): unknown {
	const anyInput = input as any
	if (typeof anyInput.getValue === 'function') {
		// no value yet reads as undefined: a StateObservable hands back a StatePromise once subscribed,
		// and throws NoSubscribersError before that (getSnapshot runs before subscribe on first render)
		try {
			const v = anyInput.getValue()
			return v instanceof Promise ? undefined : v
		} catch {
			return undefined
		}
	}
	if (typeof anyInput.getState === 'function') return anyInput.getState()
	return undefined
}

const NO_DECOS: DecorationEntry[] = []

// Manual subscription rather than one Zus.useStore per registration, so the hook count stays fixed
// while plugins register and unregister at runtime.
export function useDecorations<A extends DecorationAnchorId>(anchor: A, props: DecorationAnchors[A]): DecorationEntry[] {
	const version = Zus.useStore(Store, (s) => s.version)
	const propsKey = JSON.stringify(props)
	const cache = React.useRef<{ key: string; decos: DecorationEntry[] }>({ key: '', decos: NO_DECOS })
	const subscribe = React.useCallback(
		(onChange: () => void) => {
			const unsubs: (() => void)[] = []
			for (const reg of decoRegs.get(anchor) ?? []) {
				for (const input of reg.stores(props)) unsubs.push(subscribeInput(input, onChange))
			}
			return () => {
				for (const unsub of unsubs) unsub()
			}
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[anchor, propsKey, version],
	)
	const getSnapshot = () => {
		const decos: DecorationEntry[] = []
		for (const reg of decoRegs.get(anchor) ?? []) {
			const states = reg.stores(props).map(readInput)
			try {
				const deco = reg.select(...states, props)
				if (deco) decos.push({ ...deco, regKey: reg.regKey })
			} catch {
				// a selector tripping over a pending state reads as no decoration
			}
		}
		const key = JSON.stringify([version, decos])
		if (cache.current.key === key) return cache.current.decos
		cache.current = { key, decos: decos.length > 0 ? decos : NO_DECOS }
		return cache.current.decos
	}
	return React.useSyncExternalStore(subscribe, getSnapshot)
}

// ---- host lifecycle ----

export function setup(installedPlugins: InstalledClientPlugin[]) {
	installed = installedPlugins
	RPC.observe('plugins.watchPlugins', () => RPC.orpc.plugins.watchPlugins.call()).subscribe((infos) => {
		Store.setState((s) => ({ ...s, plugins: infos as PLG.RuntimeInfo[] }))
		void reconcile(infos as PLG.RuntimeInfo[])
	})
}

async function reconcile(infos: PLG.RuntimeInfo[]) {
	for (const info of infos) {
		const active = info.status === 'active'
		if (active && info.hasClient && !loadedPlugins.has(info.id)) {
			loadedPlugins.add(info.id)
			const entry = installed.find((e) => e.manifest.id === info.id)
			if (!entry?.client) continue
			try {
				const mod = (await entry.client()).default
				mod.setup({ plugin: { id: info.id, manifest: entry.manifest } })
				bumpVersion()
			} catch (err) {
				console.error(`plugin ${info.id}: client setup failed`, err)
			}
		} else if (!active && loadedPlugins.has(info.id)) {
			loadedPlugins.delete(info.id)
			for (const undo of undoByPlugin.get(info.id) ?? []) undo()
			undoByPlugin.delete(info.id)
			bumpVersion()
		}
	}
}
