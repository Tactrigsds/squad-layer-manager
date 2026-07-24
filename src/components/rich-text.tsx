import { cn } from '@/lib/utils'
import React from 'react'

// only an explicit scheme counts, so nothing a user writes can turn into a javascript: link
const URL_PATTERN = /https?:\/\/[^\s<>"']+/g
const TRAILING_PUNCTUATION = /[.,;:!?]+$/

// The one piece of rich text user-authored copy gets: bare urls render as links. Everything else stays literal.
export function RichText(props: { text: string; className?: string }) {
	const parts: React.ReactNode[] = []
	let cursor = 0
	for (const match of props.text.matchAll(URL_PATTERN)) {
		const url = match[0].replace(TRAILING_PUNCTUATION, '')
		const start = match.index
		if (start > cursor) parts.push(props.text.slice(cursor, start))
		parts.push(
			<a
				key={start}
				href={url}
				target="_blank"
				rel="noreferrer noopener"
				className="underline underline-offset-2 hover:text-primary"
				onClick={(e) => e.stopPropagation()}
			>
				{url}
			</a>,
		)
		cursor = start + url.length
	}
	if (cursor < props.text.length) parts.push(props.text.slice(cursor))
	return <span className={cn('whitespace-pre-wrap break-words', props.className)}>{parts}</span>
}
