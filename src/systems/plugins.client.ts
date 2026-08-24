import { createORPCClient } from '@orpc/client'
import type { ClientLink } from '@orpc/client'
import type { AnyRouter, RouterClient } from '@orpc/server'
import * as React from 'react'
import { toast } from 'sonner'

import * as ReactRx from '@/lib/react-rxjs'
import * as Rx from '@/lib/rxjs'
import * as Zus from '@/lib/zustand'
import * as PLUGINS_Msgs from '@/messages/plugins.messages'
import type * as PLG from '@/models/plugins.models'
import * as RPC from '@/orpc.client'
import { tr } from '@/systems/messages.client'
import * as ApiRegistry from '@/systems/plugin-api-registry.client'

// Client half of the plugin host: watches which plugins are active, loads their client entries, and
// holds what those entries register -- slot components, row decorations, rpc query stores. Anchors
// are a closed, typed set: a plugin renders only where the host has placed one.
//
// A builtin's client is a lazy import in the app bundle. A packaged plugin's is fetched from
// /plugin-assets and resolves `slm/*` and react through the import map in index.html, so it shares
// this page's instances rather than shipping its own.

export type ClientCtx<M extends PLG.Manifest<any> = PLG.Manifest> = {
	plugin: { id: PLG.PluginId; manifest: M }
}

export type ClientModule = { manifest: PLG.Manifest; setup: (ctx: ClientCtx<any>) => void }

/**
 * Declares a plugin's client entry. Default-export the result from client.tsx: the host calls `setupFn`
 * when the plugin becomes active, and undoes everything it registered when the plugin stops.
 */
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
export type Decoration = { tint?: Tint; title?: string; body?: string }
// what a host anchor renders: the plugin's decoration plus which registration produced it
export type DecorationEntry = Decoration & { regKey: string }
export type DecorationAnchors = {
	// layerId and ordinal come along because a decoration describing the match needs them to name a
	// side: which faction a normalized team held depends on both
	'match-history:row': { serverId: string; matchId: number; layerId: string; ordinal: number }
}
export type DecorationAnchorId = keyof DecorationAnchors

// regKey is stable per registration, so React can key a slot or a decoration by its origin rather
// than its position: one plugin may register twice at the same anchor.
type SlotReg = { pluginId: string; regKey: string; component: React.FC<any> }
type DecorationReg = {
	pluginId: string
	regKey: string
	stores: (props: any) => Zus.AnyInput<any>[]
	select: (...args: any[]) => Decoration | Decoration[] | null | undefined
}

// version bumps whenever the registration set changes; consumers re-subscribe off it. `manifests`
// carries every known plugin's manifest, builtin or packaged, which is what the settings form needs
// to render a config editor for a plugin that is not running.
export const Store = Zus.createStore<{ plugins: PLG.RuntimeInfo[]; version: number; manifests: Record<string, PLG.Manifest> }>(() => ({
	plugins: [],
	version: 0,
	manifests: {},
}))
const slotRegs = new Map<string, SlotReg[]>()
const decoRegs = new Map<string, DecorationReg[]>()
const undoByPlugin = new Map<string, (() => void)[]>()
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

/**
 * Mounts a component at one of the host's anchor points. Each is rendered inside an error boundary, so
 * a throwing plugin component cannot take the page down. Anchors are a closed set.
 */
export function registerSlot<A extends SlotAnchorId>(ctx: ClientCtx<any>, anchor: A, component: React.FC<SlotAnchors[A]>) {
	pushReg(slotRegs, anchor, ctx.plugin.id, { pluginId: ctx.plugin.id, regKey: nextRegKey(ctx.plugin.id), component })
	bumpVersion()
}

/**
 * Contributes data, not markup, to a host anchor: the host owns the styling and maps the tint onto it.
 * `stores` names the inputs to watch for the given props, and `select` is called as
 * `select(...storeStates, props)`. Return null for no decoration; a selector that throws reads as none.
 */
export function registerDecoration<A extends DecorationAnchorId>(
	ctx: ClientCtx<any>,
	anchor: A,
	reg: {
		stores: (props: DecorationAnchors[A]) => Zus.AnyInput<any>[]
		// called as select(...storeStates, props). Return several when one registration has several
		// things to say about the same row; the host renders one of each.
		select: (...args: any[]) => Decoration | Decoration[] | null | undefined
	},
) {
	pushReg(decoRegs, anchor, ctx.plugin.id, { pluginId: ctx.plugin.id, regKey: nextRegKey(ctx.plugin.id), ...reg })
	bumpVersion()
}

export function getSlotRegs(anchor: SlotAnchorId): SlotReg[] {
	return slotRegs.get(anchor) ?? []
}

// ---- rpc ----

// A plugin's server half registers one oRPC router; both halves of this section build a client from
// that router's *type*, imported with `import type` so nothing of the server reaches the browser.
// The transport is the host's two generic procedures, so the router itself is never mounted.

type AnyClient = Record<string, unknown>

/** The element type a streaming procedure yields. */
type StreamOf<T> = T extends AsyncIterable<infer E> ? E : never

/** Stores over a router's streaming procedures, keyed by the arguments its input needs. */
export type Stores<TRouter extends AnyRouter> = {
	[K in keyof RouterClient<TRouter>]: RouterClient<TRouter>[K] extends (input: infer I, ...rest: never[]) => Promise<infer R>
		? (serverId: string, input: I) => Zus.ValueObservable<StreamOf<R> | undefined>
		: never
}

function unwrap(res: unknown): unknown {
	if (res && typeof res === 'object' && 'code' in res) {
		const coded = res as { code: string; data?: unknown }
		if (coded.code === 'ok') return coded.data
		throw new Error(`plugin rpc failed: ${coded.code}`)
	}
	return res
}

/**
 * A typed client over the plugin's non-streaming procedures, inferred from its router type:
 * `Rpc.client<typeof router>(ctx, serverId).things({ ... })`.
 */
export function client<TRouter extends AnyRouter>(ctx: ClientCtx<any>, serverId: string): RouterClient<TRouter> {
	const link: ClientLink<Record<never, never>> = {
		async call(path, input) {
			return unwrap(await RPC.orpc.plugins.rpcCall.call({ pluginId: ctx.plugin.id, path: [...path], serverId, input }))
		},
	}
	return createORPCClient(link as never) as RouterClient<TRouter>
}

/**
 * Stores over the plugin's streaming procedures, inferred the same way. Deep-equal arguments share one
 * instance. Values are unwrapped, and read as undefined before the first value or while the server is
 * not loaded, so selectors stay total.
 */
export function stores<TRouter extends AnyRouter>(ctx: ClientCtx<any>): Stores<TRouter> {
	const families = new Map<string, (serverId: string, input: unknown) => Zus.ValueObservable<unknown>>()
	const target = {} as AnyClient
	return new Proxy(target, {
		get(_t, prop: string) {
			let family = families.get(prop)
			if (!family) {
				family = streamFamily(ctx, prop)
				families.set(prop, family)
			}
			return family
		},
	}) as Stores<TRouter>
}

function streamFamily(ctx: ClientCtx<any>, name: string) {
	// Keyed on a serialized input rather than the object itself: the family caches instances by its
	// arguments, and a caller writing `streams.things(serverId, {})` in a component body hands over a
	// fresh object every render. Keying on that would mint a new stream per render instead of sharing
	// one, so nothing would ever settle.
	const [, family$] = ReactRx.bind(`plugins.${ctx.plugin.id}.${name}`, (serverId: string, inputKey: string) =>
		RPC.observe(`plugins.rpcStream:${ctx.plugin.id}.${name}`, () =>
			RPC.orpc.plugins.rpcStream.call({ pluginId: ctx.plugin.id, path: [name], serverId, input: JSON.parse(inputKey) }),
		).pipe(Rx.map((res) => (res && typeof res === 'object' && 'code' in res && res.code === 'ok' ? res.data : undefined))),
	)
	// Wrapped so getValue is total: a raw StateObservable throws NoSubscribersError before its first
	// subscriber and hands back a StatePromise before its first value, and consumers (selectors, the
	// decoration snapshot) read "no value yet" for both. Cached per underlying instance so deep-equal
	// args keep sharing one store.
	const safeCache = new WeakMap<object, Zus.ValueObservable<unknown>>()
	return (serverId: string, input: unknown) => {
		const obs = family$(serverId, JSON.stringify(input ?? {}))
		let safe = safeCache.get(obs)
		if (!safe) {
			safe = Object.assign(new Rx.Observable<unknown>((subscriber) => obs.subscribe(subscriber)), {
				getValue: (): unknown => {
					try {
						const v = obs.getValue()
						return isThenable(v) ? undefined : v
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
				const selected = reg.select(...states, props)
				const list = Array.isArray(selected) ? selected : selected ? [selected] : []
				// the index keeps React keys distinct when one registration contributes several
				list.forEach((deco, i) => decos.push({ ...deco, regKey: `${reg.regKey}:${i}` }))
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

// what this page has already evaluated for each plugin. Never dropped: esm cannot unload, so once a
// bundle has run here, a different one for the same plugin means the page is stale.
const evaluatedFrom = new Map<string, string>()
// plugins whose registrations are currently live
const liveClients = new Set<string>()
const requestedManifests = new Set<string>()
const reloadPrompted = new Set<string>()
const BUILTIN = 'builtin'

export function setup(installedPlugins: InstalledClientPlugin[]) {
	installed = installedPlugins
	// before any packaged bundle is imported: its `slm/*` and react shims read from what this publishes
	ApiRegistry.setup()
	Store.setState((s) => ({ ...s, manifests: Object.fromEntries(installedPlugins.map((e) => [e.manifest.id, e.manifest])) }))
	RPC.observe('plugins.watchPlugins', () => RPC.orpc.plugins.watchPlugins.call()).subscribe((infos) => {
		Store.setState((s) => ({ ...s, plugins: infos as PLG.RuntimeInfo[] }))
		void reconcile(infos as PLG.RuntimeInfo[])
	})
}

async function reconcile(infos: PLG.RuntimeInfo[]) {
	for (const info of infos) {
		if (info.manifestEntry && !requestedManifests.has(info.manifestEntry)) {
			requestedManifests.add(info.manifestEntry)
			await loadManifest(info)
		}
		const active = info.status === 'active'
		if (active && info.hasClient) {
			const source = info.clientEntry ?? BUILTIN
			const previous = evaluatedFrom.get(info.id)
			if (previous !== undefined && previous !== source) {
				promptReload(info)
				continue
			}
			if (liveClients.has(info.id)) continue
			liveClients.add(info.id)
			evaluatedFrom.set(info.id, source)
			await loadClient(info)
		} else if (!active && liveClients.has(info.id)) {
			liveClients.delete(info.id)
			for (const undo of undoByPlugin.get(info.id) ?? []) undo()
			undoByPlugin.delete(info.id)
			bumpVersion()
		}
	}
}

async function loadManifest(info: PLG.RuntimeInfo) {
	try {
		const mod = (await import(/* @vite-ignore */ info.manifestEntry!)) as { default: PLG.Manifest }
		Store.setState((s) => ({ ...s, manifests: { ...s.manifests, [info.id]: mod.default } }))
	} catch (err) {
		console.error(`plugin ${info.id}: loading its manifest failed`, err)
	}
}

async function loadClient(info: PLG.RuntimeInfo) {
	try {
		const mod = info.clientEntry
			? ((await import(/* @vite-ignore */ info.clientEntry)) as { default: ClientModule }).default
			: (await installed.find((e) => e.manifest.id === info.id)?.client?.())?.default
		if (!mod) return
		mod.setup({ plugin: { id: info.id, manifest: Store.getState().manifests[info.id] ?? mod.manifest } })
		bumpVersion()
	} catch (err) {
		console.error(`plugin ${info.id}: client setup failed`, err)
	}
}

// The page holds the old bundle and cannot let go of it, so the only honest fix is a reload. Asked
// for rather than taken: an admin may be halfway through a queue edit.
function promptReload(info: PLG.RuntimeInfo) {
	if (reloadPrompted.has(info.id)) return
	reloadPrompted.add(info.id)
	toast.warning(tr.text(PLUGINS_Msgs.clientUpdated(info.name)), {
		duration: Infinity,
		action: { label: tr.text(PLUGINS_Msgs.reload()), onClick: () => window.location.reload() },
	})
}
