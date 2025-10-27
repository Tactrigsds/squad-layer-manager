import emojiNameMap from 'emoji-name-map'

export type Emoji =
	| { type: 'discord'; id: string; name: string | null }
	| { type: 'unicode'; id: string; name: string | null }

export function displayName(emoji: Emoji) {
	return emoji.name ?? emoji.id
}

export function toUnicodeEmoji(char: string | Emoji): Emoji {
	if (typeof char !== 'string') return char
	return {
		id: char,
		name: emojiNameMap.get(char) || null,
		type: 'unicode',
	}
}

export function parseDiscordEmojiId(id: string): string {
	return id.replace(/^discord_/, '')
}

export function createDiscordEmojiId(id: string): string {
	return `discord_${id}`
}

export function getEmojiIdType(id: string): 'discord' | 'unicode' | undefined {
	if (id.startsWith('_discord')) return 'discord'
	return 'unicode'
}

export function idToEmoji(id: string, discordEmojis: DiscordEmoji[] | undefined): Emoji | undefined {
	if (id.startsWith('discord_')) {
		if (!discordEmojis) return
		const discordId = parseDiscordEmojiId(id)
		return {
			id,
			name: discordEmojis.find(emoji => emoji.id === discordId)?.name || null,
			type: 'discord',
		}
	}
	return {
		id,
		name: emojiNameMap.get(id) || null,
		type: 'unicode',
	}
}

export type DiscordEmoji = Extract<Emoji, { type: 'discord' }>
export type UnicodeEmoji = Extract<Emoji, { type: 'unicode' }>
