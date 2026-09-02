import React from 'react'

import * as Interactions from '@/components/feed/interactions'
import * as RC from '@/components/feed/render-context'
import { useActorLabels } from '@/components/feed/use-actor-labels'
import { frameManager } from '@/frames/frame-manager'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import * as Zus from '@/lib/zustand'
import type * as CHAT from '@/models/chat.models'
import type * as MH from '@/models/match-history.models'
import { BaseZIndexContext } from '@/models/zindex'
import { GlobalSettingsStore } from '@/systems/client-only-settings.client'
import * as SettingsClient from '@/systems/settings.client'

// no server frame of its own; interactions resolve one per match via storesForMatch, and what they cannot
// resolve they leave inert (see interactions.ts)
const NO_FRAME_STORES = {} as SquadServerFrame.KeyProp

/**
 * A render ctx for feed rows outside any server dashboard: matches come from the query result, and a row's
 * interactions resolve their server frame from its match, falling back to `serverId` for a row that has no
 * match of its own. Frames are minted on first use, for servers that have a live managed instance.
 */
export function useHistoryRenderCtx(
	matches: MH.MatchDetails[],
	opts?: {
		events?: readonly CHAT.EventEnriched[] | null
		loadRowEvents?: RC.RenderCtx['loadRowEvents']
		// the one server every row came from, where the query named exactly one. A players result has no match
		// per row, so this is the only thing that can give its rows a frame to act on.
		serverId?: string
	},
): RC.RenderCtx {
	const { events, loadRowEvents, serverId } = opts ?? {}
	const displayTeamsNormalized = Zus.useStore(GlobalSettingsStore, (s) => s.displayTeamsNormalized)
	const settings = Zus.useStore(SettingsClient.PublicSettingsStore)
	const zIndexBase = React.useContext(BaseZIndexContext)
	const scopeId = React.useMemo(() => RC.newScopeId(), [])
	const actorLabels = useActorLabels(events)

	const ctx = React.useMemo<RC.RenderCtx>(() => {
		const byId = new Map(matches.map((m) => [m.historyEntryId, m]))
		const perServer = new Map<string, SquadServerFrame.KeyProp | null>()
		// minted on first use rather than up front: setting a frame up during render is a side effect, and
		// most scopes never have an interaction that needs one
		const frameFor = (id: string | undefined) => {
			if (!id) return undefined
			let entry = perServer.get(id)
			if (entry === undefined) {
				const server = settings?.servers.find((s) => s.id === id)
				entry = SettingsClient.isServerUsable(server)
					? { squadServer: frameManager.ensureSetup(SquadServerFrame.frame, SquadServerFrame.createInput(id)) }
					: null
				perServer.set(id, entry)
			}
			return entry ?? undefined
		}
		const storesForMatch = (matchId: number | null | undefined) => {
			const match = matchId === null || matchId === undefined ? undefined : byId.get(matchId)
			return frameFor(match?.serverId ?? serverId)
		}
		return {
			scopeId,
			stores: NO_FRAME_STORES,
			outletKey: 'default',
			zIndexBase,
			displayTeamsNormalized,
			storesForMatch,
			matchById: (matchId) => (matchId === null || matchId === undefined ? undefined : byId.get(matchId)),
			latestMatch: undefined,
			currentMatch: undefined,
			groupColor: () => null,
			loadRowEvents,
			...actorLabels,
		}
	}, [scopeId, zIndexBase, displayTeamsNormalized, matches, settings, actorLabels, loadRowEvents, serverId])

	React.useLayoutEffect(() => {
		Interactions.setup()
		RC.register(ctx)
		return () => RC.unregister(ctx.scopeId)
	}, [ctx])

	return ctx
}
