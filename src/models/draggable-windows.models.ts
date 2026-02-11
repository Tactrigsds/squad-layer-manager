import { z } from 'zod'

export const WINDOW_ID = z.enum(['player-details', 'layer-info'])

export type WindowId = z.infer<typeof WINDOW_ID>
