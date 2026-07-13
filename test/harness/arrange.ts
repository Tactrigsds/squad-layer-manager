import type * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import { ADMIN_USER } from './app-fixture'

// Builders for the state a fixture starts with. Tests arrange through these rather than through the
// UI: it's faster, and a failure while clicking through setup would masquerade as a failure of the
// thing under test.

// A layer id is `<MAP>-<GAMEMODE>-<VERSION>:<FACTION>-<UNIT>:<FACTION>-<UNIT>`. These exist in the
// layer db that ships with the app, so they survive a round trip through its queries.
export const LAYERS = {
	gorodokRaas: 'GD-RAAS-V1:USA-CA:RGF-CA',
	harjuRaas: 'HJ-RAAS-V1:RGF-MZ:PLA-AA',
	sumariSeed: 'SM-SD-V1:RGF-CA:VDV-CA',
	skorpoRaas: 'SK-RAAS-V1:USA-CA:RGF-CA',
} satisfies Record<string, L.LayerId>

export function queueItem(layerId: L.LayerId, opts?: { itemId?: string }): LL.Item {
	return LL.createItem(
		{ type: 'single-list-item', layerId, itemId: opts?.itemId },
		{ type: 'manual', userId: ADMIN_USER.discordId },
	)
}

export function queue(...layerIds: L.LayerId[]): LL.List {
	return layerIds.map((layerId) => queueItem(layerId))
}

export function voteQueueItem(choices: L.LayerId[], opts?: { itemId?: string }): LL.Item {
	return LL.createItem(
		{ type: 'vote-list-item', choices, itemId: opts?.itemId },
		{ type: 'manual', userId: ADMIN_USER.discordId },
	)
}
