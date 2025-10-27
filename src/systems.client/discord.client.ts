import * as AR from '@/app-routes'
import * as EMO from '@/models/emoji.models'
import { trpc } from '@/trpc.client'
import { useQuery } from '@tanstack/react-query'
import React from 'react'

function fetchEmojis() {
	return trpc.discord.getGuildEmojis.query()
}

export const getEmojisBaseQuery = (opts?: { enabled?: boolean }) => {
	return ({
		...opts,
		queryKey: ['discord', 'getGuildEmojis'],
		queryFn: fetchEmojis,
	})
}

export function useEmoji(id: string | undefined, opts?: { enabled?: boolean }) {
	const discordEmojisRes = useQuery(getEmojisBaseQuery(opts))
	const discordEmojis = discordEmojisRes.data

	// memo for stable reference for consumers
	const emoji = React.useMemo(() => {
		if (!id) return
		return EMO.idToEmoji(id, discordEmojis)
	}, [id, discordEmojis])

	return emoji
}

export function getEmojiUrl(emoji: Extract<EMO.Emoji, { type: 'discord' }>, size: number = 32): string {
	return AR.link('/discord-cdn/*', `emojis/${EMO.parseDiscordEmojiId(emoji.id)}.webp?size=${size}`)
}
