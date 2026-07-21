import * as BB from '@/models/backburner.models'
import * as LL from '@/models/layer-list.models'
import * as SETTINGS from '@/models/settings.models'
import * as TSW from '@/models/teamswaps.models'
import type * as USR from '@/models/users.models'
import { z } from 'zod'

export const ServerIdSchema = z.string().min(1).max(256)
export type ServerId = z.infer<typeof ServerIdSchema>

export const SavedTeamswapsSchema = z.object({
	swaps: TSW.TeamswapCollectionSchema,
	matchHistoryEntryId: z.number().int(),
})
export type SavedTeamswaps = z.infer<typeof SavedTeamswapsSchema>

export const ServerStateSchema = z.object({
	id: ServerIdSchema,
	displayName: z.string().min(1).max(256),
	enabled: z.boolean().prefault(true),
	defaultServer: z.boolean().prefault(false),
	layerQueue: LL.ListSchema,
	teamswaps: z.preprocess(
		// migrate old formats (bare Map, or the pre-rename `{ switches, matchHistoryEntryId }` shape) to null —
		// this is a transient "queued for next map" value, so dropping it on upgrade is an acceptable loss
		(val) => (val instanceof Map || (val && typeof val === 'object' && 'switches' in val) ? null : val),
		SavedTeamswapsSchema.nullable(),
	).prefault(null),
	backburner: BB.BackburnerListSchema.prefault([]),
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
				| 'teamswaps-saved'
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

export function printSource(source: LQStateUpdate['source']) {
	if (source.type === 'system') {
		const eventLabels: Record<typeof source.event, string> = {
			'server-roll': 'Server rolled to next layer',
			'app-startup': 'App startup',
			'vote-timeout': 'Vote timed out',
			'vote-abort': 'Vote aborted',
			'vote-cleared': 'Vote cleared',
			'next-layer-override': 'Next layer overridden',
			'vote-start': 'Vote started',
			'admin-change-layer': 'Admin changed layer',
			'filter-delete': 'Filter deleted',
			'next-layer-generated': 'Next layer generated',
			'updates-to-squad-server-toggled': 'Updates to Squad server toggled',
			'ended-early': 'Vote ended early',
			'teamswap-execution-completed': 'Teamswaps Executed',
			'teamswaps-saved': 'Teamswaps Saved',
			'backburner-updated': 'Layer requests updated',
		}
		return eventLabels[source.event]
	} else {
		const eventLabels: Record<typeof source.event, string> = {
			'edit-queue': 'saved changes to the queue',
			'edit-settings': 'edited the queue settings',
		}
		return `${source.user.displayName} ${eventLabels[source.event]}`
	}
}
