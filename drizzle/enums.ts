import { z } from 'zod'

// this file exists so that most modules don't have to depend on a full module import of the schema. tree shaking probably would have taken care of it anyway but not in dev mode I guess :shrug:

export const BALANCE_TRIGGER_LEVEL = z.enum(['info', 'warn', 'violation'])
export type BalanceTriggerLevel = z.infer<typeof BALANCE_TRIGGER_LEVEL>

// this is append only to not mix up the existing enum indexes
export const SERVER_EVENT_TYPE = z.enum([
	'NEW_GAME',
	'ROUND_ENDED',
	'PLAYER_CONNECTED',
	'PLAYER_DISCONNECTED',
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
])

export type ServerEventType = z.infer<typeof SERVER_EVENT_TYPE>
