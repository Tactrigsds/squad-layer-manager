import { z } from 'zod'

// this file exists so that most modules don't have to depend on a full module import of the schema. tree shaking probably would have taken care of it anyway but not in dev mode I guess :shrug:

export const BALANCE_TRIGGER_LEVEL = z.enum(['info', 'warn', 'violation'])
export type BalanceTriggerLevel = z.infer<typeof BALANCE_TRIGGER_LEVEL>

// this is APPEND ONLY, so that we don't mix up the existing enum indexes
export const SERVER_EVENT_TYPE = z.enum([
	'NEW_GAME',
	'ROUND_ENDED',
	'PLAYER_CONNECTED',
	'PLAYER_DISCONNECTED',
	// a player RCON reported as present but who was missing from our roster, backfilled by the teams-poll
	// reconciler (see reconcileTeamsUpdate). Distinct from PLAYER_CONNECTED, which means an actual join.
	'PLAYER_RECONCILED',
	'SQUAD_CREATED',
	'CHAT_MESSAGE',
	'ADMIN_BROADCAST',
	'POSSESSED_ADMIN_CAMERA',
	'UNPOSSESSED_ADMIN_CAMERA',
	'PLAYER_KICKED',
	'PLAYER_BANNED',
	'PLAYER_WARNED',
	'PLAYER_DETAILS_CHANGED',
	'PLAYER_CHANGED_TEAM',
	'PLAYER_LEFT_SQUAD',
	'SQUAD_DISBANDED',
	'PLAYER_JOINED_SQUAD',
	'PLAYER_PROMOTED_TO_LEADER',
	'RESET',
	'PLAYER_DIED',
	'PLAYER_WOUNDED',
	'MAP_SET',
	'RCON_CONNECTED',
	'RCON_DISCONNECTED',
	'SQUAD_DETAILS_CHANGED',
	'SQUAD_RENAMED',
	'LAYER_CHANGED',
	'TEAMS_POLLED_UPDATE',
])

export type ServerEventType = z.infer<typeof SERVER_EVENT_TYPE>

// application (audit-log) events. APPEND ONLY.
export const APP_EVENT_TYPE = z.enum([
	'PLAYER_WARNED',
	'SQUAD_DISBANDED',
	'PLAYER_REMOVED_FROM_SQUAD',
	'TEAM_CHANGE_FORCED',
	'PLAYER_KILLED',
	'SQUAD_RENAMED',
	'COMMANDER_DEMOTED',
	'FOG_OF_WAR_TOGGLED',
	'MATCH_ENDED',
	'VOTE_STARTED',
	'VOTE_ENDED',
	'VOTE_ABORTED',
	'QUEUE_UPDATED',
	'SETTINGS_UPDATED',
	'SERVER_REGISTRY_CHANGED',
	'FILTER_CHANGED',
	'FILTER_CONTRIBUTOR_CHANGED',
	'USER_ACCOUNT_CHANGED',
	'PLAYER_FLAGS_UPDATED',
	'APP_STARTED',
	'APP_RESTARTED',
	'MAP_SET',
	'BROADCAST_SENT',
	'PLAYER_TIMED_OUT',
	'TIMEOUT_CANCELLED',
	'TEAMSWAPS_UPDATED',
	'PLAYER_KICKED',
	'BACKUP_CREATED',
	'LAYER_REQUEST_ADDED',
	'LAYER_REQUEST_REMOVED',
	'LAYER_REQUEST_CONSUMED',
])
export type AppEventType = z.infer<typeof APP_EVENT_TYPE>

export const APP_EVENT_ACTOR_TYPE = z.enum([
	'slm-user',
	'ingame-user',
	'system',
])
export type AppEventActorType = z.infer<typeof APP_EVENT_ACTOR_TYPE>

export const SERVER_EVENT_PLAYER_ASSOC_TYPE = z.enum([
	'player', // default
	'attacker',
	'victim',
	'game-participant', // participants will be part of a NEW_GAME or INIT, and they are treated as a collection during serialization/deserialization
])

export type ServerEventPlayerAssocType = z.infer<typeof SERVER_EVENT_PLAYER_ASSOC_TYPE>
