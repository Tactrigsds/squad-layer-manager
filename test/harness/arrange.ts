import * as CMD from '@/models/command.models'
import type * as F from '@/models/filter.models'
import type * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import type * as LTag from '@/models/layer-tags.models'
import type * as SETTINGS from '@/models/settings.models'
import type * as RBAC from '@/rbac.models'

import { ADMIN_USER, type TestUser } from './app-fixture'

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

// Matches a layer name as a whole name. `hasText` with a bare string is a substring match, and a mod layer name
// embeds the vanilla one it is derived from: 'Narva_RAAS_v1' also picks out 'Supermod_Narva_RAAS_v1_SPM'. Only an
// underscore is excluded on either side, because that is the one character a mod name pads with; the text
// `hasText` matches runs adjacent cells together, so the name is routinely flanked by the item number and a
// faction ('3Gorodok_AAS_v1RGF...') and a stricter word boundary would reject it.
export function layerText(layerName: string): RegExp {
	return new RegExp(`(?:^|[^_])${layerName}(?!_)`)
}

// An in-game command as an admin types it. The prefix is not restated, so these follow whatever a fresh install
// seeds -- a trigger that does not start with an allowed prefix is refused by the settings schema, so a literal
// would fail the whole fixture rather than the assertion it belongs to.
export function cmd(command: string): string {
	return `${CMD.DEFAULT_PREFIX}${command}`
}

export function queueItem(layerId: L.LayerId, opts?: { itemId?: string; tags?: LTag.TagId[] }): LL.Item {
	return LL.createItem(
		{ type: 'single-list-item', layerId, itemId: opts?.itemId, tags: opts?.tags },
		{ type: 'manual', userId: ADMIN_USER.discordId },
	)
}

// A tag definition plus the id to attach to items. Tag ids are `<label>:<6 chars>` and immutable, so the suffix is
// fixed here rather than generated.
export function layerTag(label: string, suffix: string): LTag.Tag {
	return { id: `${label}:${suffix}`, label, description: '', color: '#3b82f6' }
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

// An rbac role assigned to the given users and/or whole in-game admin lists. Caps that ride on a role
// (maxTimeout, maxLayerRequests) go in opts.
export function role(
	permissions: RBAC.RolePermissionExpression[],
	assign: { users?: TestUser[]; ingameAdminLists?: string[] },
	opts?: Partial<Pick<SETTINGS.GlobalSettings['rbac']['roles'][string], 'maxTimeout' | 'maxLayerRequests'>>,
): SETTINGS.GlobalSettings['rbac']['roles'][string] {
	return {
		permissions,
		...opts,
		globalSettingsGrants: [],
		serverSettingsGrants: [],
		serverGrants: [],
		assignments: {
			discordRoleIds: [],
			discordUserIds: (assign.users ?? []).map((u) => String(u.discordId)),
			everyMember: false,
			ingameAdminLists: assign.ingameAdminLists ?? [],
			adminListGroups: [],
		},
	}
}

// Registers a filter as default-selectable (pre-applied during layer selection) and indicating its matches --
// the config a secondary filter most often carries.
export function selectableFilter(
	pool: SETTINGS.PoolConfiguration,
	filterId: F.FilterEntityId,
	opts?: { applyAs?: SETTINGS.SelectableFilterApplyAs },
) {
	pool.defaultSelectable.push({ filterId, applyAs: opts?.applyAs ?? 'regular' })
	pool.indicateMatches.push(filterId)
}
