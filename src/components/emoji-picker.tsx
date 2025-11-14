import { assertNever } from '@/lib/type-guards'
import { cn } from '@/lib/utils'
import * as DiscordClient from '@/systems.client/discord.client'
import * as ThemeClient from '@/systems.client/theme'
import { useQuery } from '@tanstack/react-query'
import EmojiPicker, { EmojiClickData, EmojiStyle, Theme } from 'emoji-picker-react'
import React from 'react'
import { useMemo } from 'react'

export type UnifiedEmojiPickerProps = {
	onEmojiClick: (emoji: string) => void
	emojiStyle?: EmojiStyle
	width?: number | string
	height?: number | string
	autoFocusSearch?: boolean
	searchPlaceholder?: string
	hidden?: string[]
	className?: string
	previewConfig?: {
		defaultEmoji?: string
		defaultCaption?: string
		showPreview?: boolean
	}
	guildEmojiSize?: number
}

export function UnifiedEmojiPicker(props: UnifiedEmojiPickerProps) {
	const {
		emojiStyle = EmojiStyle.NATIVE,
		width = 350,
		height = 450,
		autoFocusSearch = true,
		searchPlaceholder = 'Search emojis...',
		className,
		previewConfig,
		guildEmojiSize = 48,
	} = props

	const { data: guildEmojis, isLoading } = useQuery(DiscordClient.getEmojisBaseQuery())
	const { theme: clientTheme } = ThemeClient.useTheme()
	let theme: Theme
	switch (clientTheme) {
		case 'light':
			theme = Theme.LIGHT
			break
		case 'dark':
			theme = Theme.DARK
			break
		case 'system':
			theme = Theme.AUTO
			break
		default:
			assertNever(clientTheme)
	}

	const customEmojis = useMemo(() => {
		if (!guildEmojis) return []

		return guildEmojis.map((emoji) => ({
			id: emoji.id, // will have `discord_` as a prefix
			names: [emoji.name ?? emoji.id],
			imgUrl: DiscordClient.getEmojiUrl(emoji, guildEmojiSize),
		}))
	}, [guildEmojis, guildEmojiSize])

	const onEmojiClick = (emojiData: EmojiClickData) => {
		props.onEmojiClick(emojiData.emoji)
	}

	// React.useLayoutEffect(() => {
	// 	const imgs = document.querySelectorAll('.EmojiPickerReact img')
	// 	for (const img of imgs) {
	// 		img.setAttribute('crossorigin', 'anonymous')
	// 		img.setAttribute('data-testid', `emoji-img-${Math.random()}`)
	// 	}
	// })

	const categories = [
		{
			category: 'custom',
			name: 'Discord Emojis',
		},
		{
			category: 'suggested',
			name: 'Recently Used',
		},
		{
			category: 'smileys_people',
			name: 'Smileys & People',
		},
		{
			category: 'animals_nature',
			name: 'Animals & Nature',
		},
		{
			category: 'food_drink',
			name: 'Food & Drink',
		},
		{
			category: 'travel_places',
			name: 'Travel & Places',
		},
		{
			category: 'activities',
			name: 'Activities',
		},
		{
			category: 'objects',
			name: 'Objects',
		},
		{
			category: 'symbols',
			name: 'Symbols',
		},
		{
			category: 'flags',
			name: 'Flags',
		},
	] as any

	if (isLoading) {
		return (
			<div
				className="flex items-center justify-center"
				style={{ width, height }}
			>
				<div className="text-sm text-muted-foreground">Loading emojis...</div>
			</div>
		)
	}

	return (
		<EmojiPicker
			onEmojiClick={onEmojiClick}
			theme={theme}
			emojiStyle={emojiStyle}
			hiddenEmojis={props.hidden}
			width={width}
			height={height}
			autoFocusSearch={autoFocusSearch}
			searchPlaceholder={searchPlaceholder}
			className={cn(className, 'bg-background')}
			previewConfig={previewConfig}
			customEmojis={customEmojis}
			categories={categories}
		/>
	)
}
