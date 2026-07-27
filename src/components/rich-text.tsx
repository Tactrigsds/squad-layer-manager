import React from 'react'

import { cn } from '@/lib/utils'

// only an explicit scheme counts, so nothing a user writes can turn into a javascript: link
const URL_PATTERN = /https?:\/\/[^\s<>"']+/g
const TRAILING_PUNCTUATION = /[.,;:!?]+$/

// The one piece of rich text user-authored copy gets: bare urls render as links. Everything else stays literal.
// `maxLength` cuts the text down to a preview, appending an ellipsis.
export function RichText(props: { text: string; maxLength?: number; className?: string }) {
	const limit = props.maxLength ?? props.text.length
	const truncated = props.text.length > limit
	const parts: React.ReactNode[] = []
	let cursor = 0
	for (const match of props.text.matchAll(URL_PATTERN)) {
		const url = match[0].replace(TRAILING_PUNCTUATION, '')
		const start = match.index
		// a url the limit cuts short stays literal text, since half an address links somewhere else entirely
		if (start + url.length > limit) break
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
	const tail = props.text.slice(cursor, limit)
	if (tail) parts.push(truncated ? tail.trimEnd() : tail)
	if (truncated) parts.push('…')
	return <span className={cn('whitespace-pre-wrap break-words', props.className)}>{parts}</span>
}
