import * as L from 'slm/models/layer'
import * as MH from 'slm/models/match-history'
import type { ClientCtx } from 'slm/plugin/client'
import * as Rpc from 'slm/plugin/rpc.client'

import type manifest from './plugin.ts'
import type * as S from './schema.ts'
// type-only, so none of the server bundle reaches the browser: it is where the rpc types come from
import type { router } from './server.ts'

// The plugin's client-side handles, kept out of the .tsx files so those can export components and
// nothing else. That is what makes them Fast Refresh boundaries: editing a component then swaps its
// implementation in place instead of reloading the page.

let streams: Rpc.Stores<typeof router> | undefined

export function init(ctx: ClientCtx<typeof manifest>) {
	streams = Rpc.stores<typeof router>(ctx)
}

// a keyed family: deep-equal arguments share an instance, so the alert slot and every decorated row
// read one stream per server
export function activeEvents(serverId: string) {
	if (!streams) throw new Error('balance-triggers: init(ctx) has not run')
	return streams.activeEvents(serverId, {})
}

// most severe first, as the match history tooltip orders them
export const LEVEL_ORDER: Record<string, number> = { violation: 3, warn: 2, info: 1 }

export const TINT_CLASSES: Record<string, string> = {
	info: 'border-blue-500/50 text-blue-500',
	warn: 'border-yellow-500/50 text-yellow-600',
	violation: 'border-red-500/50 text-red-500',
}

// the same sentence the post-roll reminder uses, with the side named for the match it is shown against
export function describe(event: S.TriggerEvent, layerId: string, ordinal: number) {
	const faction = L.toLayer(layerId)[MH.getTeamNormalizedFactionProp(ordinal, event.strongerTeam as MH.NormedTeamProp)]
	const team = MH.toNormedTeamId(event.strongerTeam as MH.NormedTeamProp)
	return event.message.replace('{{strongerTeam}}', faction ? `Team ${team}(${faction})` : `Team ${team}`)
}
