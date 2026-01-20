import { z } from 'zod'

export const WINDOW_ID = z.enum(['player-details'])

export type WindowId = z.infer<typeof WINDOW_ID>
