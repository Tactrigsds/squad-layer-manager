import * as EMO from '@/models/emoji.models'
import * as D from 'discord.js'
import { z } from 'zod'

export function toNormalizedEmoji(emoji: D.GuildEmoji): EMO.DiscordEmoji {
	return {
		id: EMO.createDiscordEmojiId(emoji.id),
		name: emoji.name,
		type: 'discord',
	}
}

export const GetEmojisOptionsSchema = z.object({}).optional()

export type GetEmojisOptions = z.infer<typeof GetEmojisOptionsSchema>

export const GetEmojiOptionsSchema = z.object({ id: z.string() })
export type GetEmojiOptions = z.infer<typeof GetEmojiOptionsSchema>
