import { z } from 'zod'

import * as BB from '@/models/backburner.models'
import * as LL from '@/models/layer-list.models'
import * as SETTINGS from '@/models/settings.models'
import * as SRQ from '@/models/switch-requests.models'
import * as TSW from '@/models/teamswaps.models'
import type * as USR from '@/models/users.models'

export const ServerIdSchema = z.string().min(1).max(256)
export type ServerId = z.infer<typeof ServerIdSchema>

// A 'scoped' server is delivered to and usable by only its owner (ownerDiscordId); tutorials create one emulated
// server per user this way. 'public' is every other server. See RBAC scoping in rbac.models/rbac.server.
export const ServerVisibilitySchema = z.enum(['public', 'scoped'])
export type ServerVisibility = z.infer<typeof ServerVisibilitySchema>

export const SavedTeamswapsSchema = z.object({
	swaps: TSW.TeamswapCollectionSchema,
	matchHistoryEntryId: z.number().int(),
})
export type SavedTeamswaps = z.infer<typeof SavedTeamswapsSchema>

// the switch-request queue is match-scoped, so what's restored is keyed to the match it was saved during
export const SavedSwitchRequestsSchema = z.object({
	requests: z.array(SRQ.SwitchRequestSchema),
	disconnected: z.array(z.string()),
	matchHistoryEntryId: z.number().int(),
})
export type SavedSwitchRequests = z.infer<typeof SavedSwitchRequestsSchema>

export const ServerStateSchema = z.object({
	id: ServerIdSchema,
	displayName: z.string().min(1).max(256),
	enabled: z.boolean().prefault(true),
	defaultServer: z.boolean().prefault(false),
	layerQueue: LL.ListSchema,
	teamswaps: z
		.preprocess(
			// migrate old formats (bare Map, or the pre-rename `{ switches, matchHistoryEntryId }` shape) to null —
			// this is a transient "queued for next map" value, so dropping it on upgrade is an acceptable loss
			(val) => (val instanceof Map || (val && typeof val === 'object' && 'switches' in val) ? null : val),
			SavedTeamswapsSchema.nullable(),
		)
		.prefault(null),
	backburner: BB.BackburnerListSchema.prefault([]),
	switchRequests: SavedSwitchRequestsSchema.nullable().prefault(null),
	visibility: ServerVisibilitySchema.prefault('public'),
	ownerDiscordId: z.bigint().nullable().prefault(null),
	settings: SETTINGS.ServerSettingsSchema,
})

export type ServerState = z.infer<typeof ServerStateSchema>

export type LQStateUpdate = {
	state: ServerState
	source:
		| {
				type: 'system'
				event:
					| 'server-roll'
					| 'app-startup'
					| 'ended-early'
					| 'vote-timeout'
					| 'vote-abort'
					| 'vote-cleared'
					| 'next-layer-override'
					| 'vote-start'
					| 'admin-change-layer'
					| 'filter-delete'
					| 'next-layer-generated'
					| 'updates-to-squad-server-toggled'
					| 'ingame-vote-detected'
					| 'teamswaps-saved'
					| 'switch-requests-saved'
					| 'teamswap-execution-completed'
					| 'backburner-updated'
		  }
		// TODO bring this up to date with signature of VoteStateUpdate
		| {
				type: 'manual'
				event: 'edit-queue' | 'edit-settings'
				user: USR.MiniUser
		  }
}
