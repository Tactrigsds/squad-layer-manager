import type * as F from '@/models/filter.models'
import type * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import type * as SETTINGS from '@/models/settings.models'
import { ADMIN_USER } from './app-fixture'

// Builders for the state a fixture starts with. Tests arrange through these rather than through the
// UI: it's faster, and a failure while clicking through setup would masquerade as a failure of the
// thing under test.

// A layer id is `<MAP>-<GAMEMODE>-<VERSION>:<FACTION>-<UNIT>:<FACTION>-<UNIT>`. These exist in the
// layer db that ships with the app, so they survive a round trip through its queries.
export const LAYERS = {
	gorodokRaas: 'GD-RAAS-V1:USA-CA:RGF-CA',
	// same map as gorodokRaas: a queue holding both violates a `Map` repeat rule
	gorodokAas: 'GD-AAS-V1:USA-CA:RGF-CA',
	harjuRaas: 'HJ-RAAS-V1:RGF-MZ:PLA-AA',
	narvaRaas: 'NV-RAAS-V1:USA-CA:RGF-CA',
	sumariSeed: 'SM-SD-V1:RGF-CA:VDV-CA',
	sumariRaas: 'SM-RAAS-V1:ADF-CA:USA-CA',
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
	const item = LL.createVoteItem(choices, { type: 'manual', userId: ADMIN_USER.discordId })
	return opts?.itemId ? { ...item, itemId: opts.itemId } : item
}

// A filter entity, owned by the seeded admin. `filter` is a validated FilterNode -- build it with the
// FB builders (e.g. `FB.and([FB.eq('Gamemode', 'RAAS')])`), whose root must be a block node.
export function filter(
	id: F.FilterEntityId,
	name: string,
	node: F.FilterNode,
	opts?: Partial<Pick<F.FilterEntity, 'description' | 'alertMessage' | 'emoji' | 'invertedAlertMessage' | 'invertedEmoji'>>,
): F.FilterEntity {
	return {
		id,
		name,
		filter: node,
		owner: ADMIN_USER.discordId,
		description: opts?.description ?? null,
		alertMessage: opts?.alertMessage ?? null,
		emoji: opts?.emoji ?? null,
		invertedAlertMessage: opts?.invertedAlertMessage ?? null,
		invertedEmoji: opts?.invertedEmoji ?? null,
	}
}

// How a pool filter behaves for a server. Defaults to the config a filter most often carries: applied
// during layer selection and indicated on the items it matches.
export function poolFilter(
	filterId: F.FilterEntityId,
	opts?: Partial<SETTINGS.PoolFilterConfig>,
): SETTINGS.PoolFilterConfig {
	return {
		filterId,
		showIndicator: 'regular',
		defaultApplyDuringLayerSelection: 'regular',
		...opts,
	}
}
