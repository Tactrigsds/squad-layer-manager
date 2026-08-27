// The plugin's client-side handles, kept out of the .tsx files so those export components and nothing else.
// That is what makes them Fast Refresh boundaries: editing the panel swaps it in place instead of reloading.

import type { ClientCtx } from 'slm/plugin/client'
import * as Rpc from 'slm/plugin/rpc.client'

import type manifest from './plugin.ts'
// type-only, so none of the server bundle reaches the browser
import type { router } from './server.ts'

let streams: Rpc.Stores<typeof router> | undefined
let ctxRef: ClientCtx<typeof manifest> | undefined

export function init(ctx: ClientCtx<typeof manifest>) {
	streams = Rpc.stores<typeof router>(ctx)
	ctxRef = ctx
}

/** a keyed family: every caller passing the same serverId shares one stream */
export function status(serverId: string) {
	if (!streams) throw new Error('seed-roller: init(ctx) has not run')
	return streams.status(serverId, {})
}

export async function cancel(serverId: string) {
	if (!ctxRef) throw new Error('seed-roller: init(ctx) has not run')
	await Rpc.client<typeof router>(ctxRef, serverId).cancel({})
}

/** mm:ss remaining, floored at zero so a late tick never renders a negative countdown */
export function countdown(deadline: number, now: number): string {
	const seconds = Math.max(0, Math.ceil((deadline - now) / 1000))
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

// type-only, so the server module is erased rather than bundled
export type { Phase, Status } from './server.ts'
