// Which parts of the client have finished starting, published on <html> for anything outside the app that has to wait
// for them, chiefly the e2e harness (test/harness/ready.ts). `data-ready` lists each signal while it holds, and
// `data-app-ready` is present while every core signal holds. Both follow live state: a dropped websocket takes `ws`
// away until it reconnects. Every change also fires READY_CHANGE_EVENT on document, for a listener that would rather
// be told than look. The attributes are the record; the event can be missed by a listener that attaches late.
import * as Rx from '@/lib/rxjs'
import * as RPC from '@/orpc.client'
import * as ConfigClient from '@/systems/config.client'
import * as LayerQueriesClient from '@/systems/layer-queries.client'

// what every page needs before it can show anything that is true
export const CORE_SIGNALS = ['ws', 'config', 'layer-data'] as const
// started only by the pages that query layers, so waiting on it is up to whoever needs it
export const OPTIONAL_SIGNALS = ['layer-engine'] as const
export type Signal = (typeof CORE_SIGNALS)[number] | (typeof OPTIONAL_SIGNALS)[number]

export const READY_CHANGE_EVENT = 'slm:ready-change'
export type ReadyChangeDetail = { signal: Signal; ready: boolean; appReady: boolean }

const held = new Set<Signal>()

function set(signal: Signal, ready: boolean) {
	if (held.has(signal) === ready) return
	if (ready) held.add(signal)
	else held.delete(signal)
	const appReady = CORE_SIGNALS.every((s) => held.has(s))
	const root = document.documentElement
	root.dataset.ready = [...held].sort().join(' ')
	root.toggleAttribute('data-app-ready', appReady)
	document.dispatchEvent(new CustomEvent<ReadyChangeDetail>(READY_CHANGE_EVENT, { detail: { signal, ready, appReady } }))
}

export function setup(layerDataLoaded: Promise<unknown>) {
	RPC.connectStatus$.subscribe((status) => set('ws', status === 'open'))
	ConfigClient.config$.pipe(Rx.take(1)).subscribe(() => set('config', true))
	void layerDataLoaded.then(() => set('layer-data', true))
	const engineReady = () => set('layer-engine', LayerQueriesClient.Store.getState().status === 'ready')
	engineReady()
	LayerQueriesClient.Store.subscribe(engineReady)
}
