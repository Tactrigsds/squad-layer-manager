import { z } from '@/lib/zod'
import * as ZodUtils from '@/lib/zod-utils'
import * as SM from '@/models/squad.models'

export const BaseSchema = z.object({
	id: z.number(),
	time: z.number(),
	matchId: z.number(),
})
export type Base = z.infer<typeof BaseSchema>

export const ActionSourceSchema = z.discriminatedUnion('type', [
	// native, log-parsed provenance -- external to SLM (an outside RCON tool or an in-game admin action)
	...SM.LogEvents.ActionSourceSchema.options,
	// link to an SLM app event (audit log). the normal SLM-originated case; upgrades over rcon/player
	// in place when SLM recognizes its own action. AppEventId is a bare string, so it needs no import here.
	z.object({ type: ZodUtils.internedLiteral('event'), id: z.string() }),
	// SLM-caused but with no dedicated app event yet (fallback)
	z.object({ type: ZodUtils.internedLiteral('system'), reason: z.string().optional() }),
])
export type ActionSource = z.infer<typeof ActionSourceSchema>
