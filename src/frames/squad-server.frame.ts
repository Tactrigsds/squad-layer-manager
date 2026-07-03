import * as ChatPrt from '@/frame-partials/chat.partial'
import * as LayerQueuePrt from '@/frame-partials/layer-queue.partial'
import * as ServerSettingsPrt from '@/frame-partials/server-settings.partial'
import * as TeamswitchesPrt from '@/frame-partials/teamswitches.partial'
import type * as FRM from '@/lib/frame'
import { getState } from '@/lib/zustand'
import * as SETTINGS from '@/models/settings.models'
import * as LayerQueueClient from '@/systems/layer-queue.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as VoteClient from '@/systems/vote.client'

import { frameManager } from './frame-manager'

export type Input = { serverId: string }

export type State = ChatPrt.Store & ServerSettingsPrt.Store & LayerQueuePrt.Store & TeamswitchesPrt.Store
export type Types = {
	name: 'squadServer'
	key: FRM.RawInstanceKey<{ serverId: string }>
	input: Input
	state: State
}

export type Key = FRM.InstanceKey<Types>
export type KeyProp = FRM.KeyProp<Types>
export type Frame = FRM.Frame<Types>

export function createInput(serverId: string): Input {
	return { serverId }
}

export const frame = frameManager.createFrame<Types>({
	name: 'squadServer',
	createKey: (frameId, input) => ({ frameId, serverId: input.serverId }),
	setup(args) {
		ChatPrt.initChat(args)
		ServerSettingsPrt.initServerSettings(args)
		LayerQueuePrt.initLayerQueue(args)
		TeamswitchesPrt.initTeamswitches(args)
		// keeps the read-only, per-server oRPC streams (serverInfo/serverRolling/layersStatus, vote state,
		// match history, unexpected-next-layer) hot for the lifetime of this frame instance
		SquadServerClient.watchServer(args.input.serverId, args.sub)
		VoteClient.watchServer(args.input.serverId, args.sub)
		MatchHistoryClient.watchServer(args.input.serverId, args.sub)
		LayerQueueClient.watchServer(args.input.serverId, args.sub)
	},
})

export namespace Sel {
	export function settings(s: State) {
		return s.settings.saved
	}
	export function settingsOrDefault(s: State | undefined) {
		return s?.settings.saved ?? SETTINGS.PublicServerSettingsSchema.parse({})
	}
}
