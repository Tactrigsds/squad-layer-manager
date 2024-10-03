import { z } from 'zod'

export const COMMANDS = ['vote', 'rtv', 'setpool'] as const

export const SquadjsEventSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('command'),
		command: z.enum(COMMANDS),
		args: z.array(z.string()),
	}),
	z.object({
		type: z.literal('current-layer-changed'),
		newLayerId: z.string(),
	}),
	z.object({
		type: z.literal('next-layer-changed'),
		layerId: z.string(),
	}),
])

export type SquadjsEvent = z.infer<typeof SquadjsEventSchema>
