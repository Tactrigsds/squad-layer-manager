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

export const MESSAGE_CONTENT_LIMIT = 2000

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
 * The quoted texts as one message's content, a code block each. The quotes share the message's length evenly; one cut
 * short to fit is returned whole as a file to attach.
 */
export function quoteContent(
	texts: string[],
	note: (omittedLines: number) => string,
): { content: string; files: { name: string; text: string }[] } {
	const separators = Math.max(texts.length - 1, 0)
	const share = Math.floor((MESSAGE_CONTENT_LIMIT - separators) / Math.max(texts.length, 1))
	const blocks: string[] = []
	const files: { name: string; text: string }[] = []
	texts.forEach((text, i) => {
		const { block, truncated } = codeBlock(text, share, note)
		blocks.push(block)
		if (truncated) files.push({ name: texts.length === 1 ? 'selection.txt' : `selection-${i + 1}.txt`, text })
	})
	return { content: blocks.join('\n'), files }
}
