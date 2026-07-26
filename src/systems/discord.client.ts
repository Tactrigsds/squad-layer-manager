import { useQuery } from '@tanstack/react-query'

import * as DM from '@/models/discord.models'
import * as EMO from '@/models/emoji.models'
import * as RPC from '@/orpc.client'

export const getEmojisBaseQuery = (opts?: { enabled?: boolean }) => {
	return RPC.orpc.discord.getGuildEmojis.queryOptions({
		input: {},
		staleTime: Infinity,
		...opts,
	})
}

export function useEmoji(id: string | undefined, opts?: { enabled?: boolean }) {
	const discordEmojisRes = useQuery(getEmojisBaseQuery(opts))
	const discordEmojis = discordEmojisRes.data

	return id ? EMO.idToEmoji(id, discordEmojis) : undefined
}

export function getEmojiUrl(emoji: Extract<EMO.Emoji, { type: 'discord' }>, size: number = 32): string {
	return `${DM.CDN_BASE}/emojis/${EMO.parseDiscordEmojiId(emoji.id)}.webp?size=${size}`
}
