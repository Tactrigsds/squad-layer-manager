import type * as D from 'discord.js'

import { z } from '@/lib/zod'
import * as EMO from '@/models/emoji.models'

export const CDN_BASE = 'https://cdn.discordapp.com'

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

export const MESSAGE_LIMIT = 2000

/**
 * `text` in a code block under `header`, within discord's message limit. Past it, the block keeps as many whole
 * lines as fit, `note` says how many were left out, and `truncated` tells the caller to attach the full text.
 */
export function codeBlockMessage(
	header: string,
	text: string,
	note: (omittedLines: number) => string,
): { content: string; truncated: boolean } {
	// a fence inside the text would close the block early
	const lines = text.replaceAll('```', '`​``').split('\n')
	const block = (kept: number) => {
		const body = `${header}\n\`\`\`\n${lines.slice(0, kept).join('\n')}\n\`\`\``
		return kept === lines.length ? body : `${body}\n${note(lines.length - kept)}`
	}
	let kept = lines.length
	while (kept > 0 && block(kept).length > MESSAGE_LIMIT) kept--
	return { content: block(kept), truncated: kept < lines.length }
}
