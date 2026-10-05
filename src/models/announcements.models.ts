import { assertNever } from '@/lib/type-guards'
import * as ZodUtils from '@/lib/zod-utils'

/**
 * An announcement message is plain text with optional `{countdown:<duration>}` tokens, e.g.
 * "SLM restarts in {countdown:2m} to update". The web banner shows a live countdown to `sentAt + duration`. The
 * in-game warn is sent once, so it shows the full duration. A token whose duration does not parse is left
 * as literal text.
 */

export type Segment = { type: 'text'; text: string } | { type: 'countdown'; durationMs: number; endsAt: number }

const COUNTDOWN_TOKEN = /\{countdown:([^}]*)\}/g

export function parseMessage(message: string, sentAt: number): Segment[] {
	const segments: Segment[] = []
	let text = ''
	let last = 0
	for (const match of message.matchAll(COUNTDOWN_TOKEN)) {
		const durationMs = ZodUtils.tryParseHumanTimeToken(match[1]!.trim())
		if (durationMs === undefined) continue
		text += message.slice(last, match.index)
		if (text) segments.push({ type: 'text', text })
		text = ''
		segments.push({ type: 'countdown', durationMs, endsAt: sentAt + durationMs })
		last = match.index + match[0].length
	}
	text += message.slice(last)
	if (text) segments.push({ type: 'text', text })
	return segments
}

export function formatCountdown(remainingMs: number) {
	return ZodUtils.formatDurationApprox(remainingMs)
}

// the message as of when it was sent, for one-shot destinations like the in-game warn
export function renderStatic(segments: Segment[]) {
	return segments
		.map((s) => {
			switch (s.type) {
				case 'text':
					return s.text
				case 'countdown':
					return formatCountdown(s.durationMs)
				default:
					assertNever(s)
			}
		})
		.join('')
}
