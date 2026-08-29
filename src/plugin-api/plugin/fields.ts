/**
 * Config fields that render as one of SLM's pickers rather than a text box.
 *
 * ```ts
 * configSchema: z.object({
 *   seedPool: Fields.filterId().describe('Pool the seeding layer is drawn from'),
 *   announceIn: Fields.discordChannelId().describe('Where the roll is announced'),
 * })
 * ```
 *
 * Each stores a plain id, so a config written through the YAML editor is unaffected and an id whose target
 * has since been deleted still round-trips rather than being dropped.
 */
export { Fields } from '@/models/plugins.models'
export type { FieldControl } from '@/models/plugins.models'
