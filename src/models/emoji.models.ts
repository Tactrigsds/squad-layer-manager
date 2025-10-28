import emojiNameMap from 'emoji-name-map'

export type Emoji =
	| { type: 'discord'; id: EmojiId; name: string | null }
	| { type: 'unicode'; id: EmojiId; name: string | null }

export type EmojiId = string

export function displayName(emoji: Emoji) {
	return emoji.name ?? emoji.id
}

export function toUnicodeEmoji(char: EmojiId | Emoji): Emoji {
	if (typeof char !== 'string') return char
	return {
		id: char,
		name: emojiNameMap.get(char) || null,
		type: 'unicode',
	}
}

export function parseDiscordEmojiId(id: EmojiId): string {
	return id.replace(/^discord_/, '')
}

export function createDiscordEmojiId(id: string): EmojiId {
	return `discord_${id}`
}

export function getEmojiIdType(id: EmojiId): 'discord' | 'unicode' | undefined {
	if (id.startsWith('discord_')) return 'discord'
	return 'unicode'
}

export function idToEmoji(id: EmojiId, discordEmojis: DiscordEmoji[] | undefined): Emoji | undefined {
	if (getEmojiIdType(id) === 'discord') {
		if (!discordEmojis) return
		return {
			id,
			name: discordEmojis.find(emoji => emoji.id === id)?.name || null,
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
