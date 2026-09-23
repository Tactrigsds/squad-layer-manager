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

// discord's embed limits: one embed's description, and the text of every embed on a message taken together
export const EMBED_DESCRIPTION_LIMIT = 4096
export const EMBEDS_TOTAL_LIMIT = 6000

/**
 * `text` in a code block within `limit` characters. Past it, the block keeps as many whole lines as fit, `note` says
 * how many were left out, and `truncated` tells the caller to attach the full text.
 */
export function codeBlock(text: string, limit: number, note: (omittedLines: number) => string): { block: string; truncated: boolean } {
	// a fence inside the text would close the block early
	const lines = text.replaceAll('```', '`​``').split('\n')
	const render = (kept: number) => {
		const body = `\`\`\`\n${lines.slice(0, kept).join('\n')}\n\`\`\``
		return kept === lines.length ? body : `${body}\n${note(lines.length - kept)}`
	}
	let kept = lines.length
	while (kept > 0 && render(kept).length > limit) kept--
	return { block: render(kept), truncated: kept < lines.length }
}

/**
 * One embed per quoted text, holding nothing but the text in a code block. The quotes share the message's embed
 * budget evenly; one cut short to fit is returned whole as a file to attach.
 */
export function quoteEmbeds(
	texts: string[],
	note: (omittedLines: number) => string,
): { embeds: D.APIEmbed[]; files: { name: string; text: string }[] } {
	const share = Math.min(EMBED_DESCRIPTION_LIMIT, Math.floor(EMBEDS_TOTAL_LIMIT / Math.max(texts.length, 1)))
	const embeds: D.APIEmbed[] = []
	const files: { name: string; text: string }[] = []
	texts.forEach((text, i) => {
		const { block, truncated } = codeBlock(text, share, note)
		embeds.push({ description: block })
		if (truncated) files.push({ name: texts.length === 1 ? 'selection.txt' : `selection-${i + 1}.txt`, text })
	})
	return { embeds, files }
}
