import { z } from '@/lib/zod'
import type * as SM from '@/models/squad.models'

// ---- JSON:API shared shapes ----

const JsonApiResourceRef = z.object({
	type: z.string(),
	id: z.string(),
})

// ---- Player flags ----

const FlagPlayerInclude = z.object({
	type: z.literal('flagPlayer'),
	id: z.string(),
	attributes: z
		.object({
			removedAt: z.string().nullable().optional(),
		})
		.nullable()
		.optional(),
	relationships: z
		.object({
			playerFlag: z.object({
				data: JsonApiResourceRef,
			}),
			player: z
				.object({
					data: JsonApiResourceRef,
				})
				.optional(),
			organization: z
				.object({
					data: JsonApiResourceRef,
				})
				.optional(),
		})
		.nullable()
		.optional(),
})

export const PlayerFlagAttributes = z.object({
	name: z.string(),
	color: z.string().nullable(),
	description: z.string().nullable(),
	icon: z.string().nullable(),
})

export type PlayerFlag = z.infer<typeof PlayerFlagAttributes> & { id: string }

const PlayerFlagInclude = z.object({
	type: z.literal('playerFlag'),
	id: z.string(),
	attributes: PlayerFlagAttributes,
})

// ---- GET /players?include=identifier,flagPlayer,playerFlag (list) ----

const IdentifierInclude = z.object({
	type: z.literal('identifier'),
	id: z.string(),
	attributes: z.object({
		type: z.string(),
		identifier: z.string(),
	}),
	relationships: z
		.object({
			player: z.object({
				data: JsonApiResourceRef,
			}),
		})
		.optional(),
})

const PlayerServerRef = z.object({
	type: z.literal('server'),
	id: z.string(),
	meta: z
		.object({
			timePlayed: z.number().nullable().optional(),
		})
		.optional(),
})

export const PlayerListResponse = z.object({
	data: z.array(
		z.object({
			type: z.literal('player'),
			id: z.string(),
			relationships: z
				.object({
					servers: z
						.object({
							data: z.array(PlayerServerRef).optional(),
						})
						.optional(),
				})
				.optional(),
		}),
	),
	included: z
		.array(z.discriminatedUnion('type', [IdentifierInclude, FlagPlayerInclude, PlayerFlagInclude]))
		.nullable()
		.optional(),
	links: z
		.object({
			next: z.string().nullable().optional(),
			prev: z.string().nullable().optional(),
		})
		.nullable()
		.optional(),
})

// ---- POST /players/quick-match ----

export const PlayerQuickMatchResponse = z.object({
	data: z.array(
		z.object({
			type: z.literal('identifier'),
			id: z.string(),
			attributes: z.object({
				type: z.string(),
				identifier: z.string(),
			}),
			relationships: z
				.object({
					player: z
						.object({
							data: z.object({ type: z.literal('player'), id: z.string() }),
						})
						.optional(),
				})
				.optional(),
		}),
	),
})

// ---- GET /players/{player_id} (single player detail with flags) ----

export const PlayerDetailResponse = z.object({
	data: z.object({
		type: z.literal('player'),
		id: z.string(),
		relationships: z
			.object({
				servers: z
					.object({
						data: z.array(PlayerServerRef).optional(),
					})
					.optional(),
			})
			.optional(),
	}),
	included: z
		.array(z.discriminatedUnion('type', [IdentifierInclude, FlagPlayerInclude, PlayerFlagInclude]))
		.nullable()
		.optional(),
})

// ---- Composite types used by server + client ----

export type PlayerFlagsAndProfile = {
	bmPlayerId: string
	flagIds: string[]
	playerIds: SM.PlayerIds.IdQuery<'eos'>
	profileUrl: string
	hoursPlayed: number
}

export type PlayerProfile = {
	hoursPlayer: number
	profileUrl: string
	bmPlayerId: string
}

export type PublicPlayerBmData = Record<string, PlayerFlagsAndProfile>
export type PlayerBmDataUpdate = { playerId: string; data: PlayerFlagsAndProfile }
export function resolveFlags(flagIds: string[], orgFlags: PlayerFlag[]): PlayerFlag[] {
	return flagIds.flatMap((id) => {
		const flag = orgFlags.find((f) => f.id === id)
		return flag ? [flag] : []
	})
}

export const UpdatePlayerFlagsInputSchema = z.object({
	steamId: z.string(),
	flagIds: z.array(z.string()),
})

export type UpdatePlayerFlagsInput = z.infer<typeof UpdatePlayerFlagsInputSchema>

// a flag being added or removed, with the reason given for that flag alone
export const FlagChangeSchema = z.object({ id: z.string(), reason: z.string().trim().optional() })
export type FlagChange = z.infer<typeof FlagChangeSchema>

// Flags carry no history of their own on BattleMetrics, so the note is the only durable record of who touched a
// player's flags and why. Both the web workflows and the in-game commands post through here so a profile reads the
// same regardless of where the action came from. One note per flag: a reason justifies one flag, and keeping them
// separate is what lets a later removal's note line up with the addition's.
export function flagChangeNote(opts: { action: 'added' | 'removed'; flagName: string; actor: string; reason?: string }): string {
	const reason = opts.reason?.trim()
	return [`Flag "${opts.flagName}" ${opts.action} by ${opts.actor} via SLM.`, ...(reason ? [`Reason: ${reason}`] : [])].join('\n')
}

// BM does not document a limit on a note's length, so this one is ours
export const NOTE_MAX_LENGTH = 2000

// how a web user is named in the notes SLM posts for them
export function webActorLabel(user: { displayName: string; discordId: bigint | string }): string {
	return `${user.displayName} (Discord ${user.discordId})`
}

// a note an admin wrote, as opposed to one SLM posted for a flag change. Signed the same way flagChangeNote is, so
// parseNote can tell who wrote it: every note SLM posts is authored on BM by the token's owner.
export function playerNote(opts: { actor: string; text: string }): string {
	return `${noteSignature(opts.actor)}:\n${opts.text.trim()}`
}

export function noteSignature(actor: string): string {
	return `Note by ${actor} via SLM`
}

// ---- GET /players/{player_id}/relationships/notes ----

export const PlayerNoteAttributes = z.object({
	note: z.string(),
	shared: z.boolean(),
	createdAt: z.string(),
	expiresAt: z.string().nullable().optional(),
	clearanceLevel: z.number().nullable().optional(),
})

const PlayerNoteResource = z.object({
	type: z.literal('playerNote'),
	id: z.string(),
	attributes: PlayerNoteAttributes,
	relationships: z
		.object({
			user: z.object({ data: JsonApiResourceRef.nullable() }).optional(),
		})
		.optional(),
})

export const PlayerNoteListResponse = z.object({
	data: z.array(PlayerNoteResource),
	included: z
		.array(
			z.object({
				type: z.string(),
				id: z.string(),
				attributes: z.object({ nickname: z.string().optional() }).optional(),
			}),
		)
		.nullable()
		.optional(),
	links: z.object({ next: z.string().nullable().optional() }).nullable().optional(),
})

export const PlayerNoteCreateResponse = z.object({ data: PlayerNoteResource })

export type NoteAuthor =
	| { kind: 'slm'; name: string }
	// written on BattleMetrics itself. name is null when BM did not include the user
	| { kind: 'bm'; name: string | null }

export type PlayerNote = {
	id: string
	createdAt: number
	author: NoteAuthor
	// set on a note SLM posted for a flag change. `text` is then the reason, or empty
	flagChange?: { action: 'added' | 'removed'; flagName: string }
	text: string
}

export type PlayerNotesResult = {
	notes: PlayerNote[]
	fetchedAt: number
	// BM had more notes than one page holds
	truncated: boolean
}

const SLM_ACTOR = String.raw`(.+) \((?:Discord|Steam) [^()]*\)`
const FLAG_NOTE = new RegExp(String.raw`^Flag "([^"]*)" (added|removed) by ${SLM_ACTOR} via SLM\.(?:\nReason: ([\s\S]*))?$`)
const ADMIN_NOTE = new RegExp(String.raw`^Note by ${SLM_ACTOR} via SLM:\n([\s\S]*)$`)

// recovers who wrote a note from the signature SLM puts on it (see playerNote, flagChangeNote)
export function parseNote(raw: { id: string; note: string; createdAt: string }, bmUserName: string | null): PlayerNote {
	const base = { id: raw.id, createdAt: Date.parse(raw.createdAt) }
	const text = noteHtmlToText(raw.note)
	const flag = FLAG_NOTE.exec(text)
	if (flag) {
		return {
			...base,
			author: { kind: 'slm', name: flag[3] },
			flagChange: { action: flag[2] as 'added' | 'removed', flagName: flag[1] },
			text: flag[4]?.trim() ?? '',
		}
	}
	const note = ADMIN_NOTE.exec(text)
	if (note) return { ...base, author: { kind: 'slm', name: note[1] }, text: note[2].trim() }
	return { ...base, author: { kind: 'bm', name: bmUserName }, text: text.trim() }
}

// Tags the BM note editor writes. Only these are stripped, so a plain text note that contains `<` keeps it.
const NOTE_HTML_TAG = /<(\/?)(p|br|div|span|strong|b|em|i|u|s|strike|del|a|ul|ol|li|h[1-6]|blockquote|code|pre)\b[^>]*>/gi
const NOTE_BLOCK_TAG = /^(?:p|div|li|h[1-6]|blockquote|pre)$/i
const HTML_ENTITY = /&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos|nbsp));/gi
const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

// Notes written on BattleMetrics are HTML. Block boundaries become newlines, and the text is never rendered as HTML.
function noteHtmlToText(note: string): string {
	let sawTag = false
	const stripped = note.replace(NOTE_HTML_TAG, (_, closing: string, tag: string) => {
		sawTag = true
		if (tag.toLowerCase() === 'br' || (closing && NOTE_BLOCK_TAG.test(tag))) return '\n'
		if (!closing && tag.toLowerCase() === 'li') return '- '
		return ''
	})
	if (!sawTag) return note
	return stripped
		.replace(HTML_ENTITY, (entity, dec?: string, hex?: string, named?: string) => {
			if (named) return NAMED_ENTITIES[named.toLowerCase()]
			const code = dec ? Number(dec) : Number.parseInt(hex!, 16)
			return code <= 0x10ffff ? String.fromCodePoint(code) : entity
		})
		.replace(/\n{3,}/g, '\n\n')
}

// Only notes every SLM user may read: shared with the org, not limited to a clearance level and not expired. The
// token can also see its owner's personal notes and notes above other admins' clearance, which SLM must not pass on.
export function isPublicNote(attrs: z.infer<typeof PlayerNoteAttributes>, now: number): boolean {
	if (!attrs.shared) return false
	if (attrs.clearanceLevel) return false
	return !attrs.expiresAt || Date.parse(attrs.expiresAt) > now
}

// ids of flags that require a reason but weren't given one. the client marks those fields required up-front; the
// server calls this to enforce it.
export function flagsMissingRequiredNote(flags: FlagChange[], requiring: string[]): string[] {
	return flags.filter((f) => requiring.includes(f.id) && !f.reason?.trim()).map((f) => f.id)
}

export type StoreState = {
	selectedGroupingId: string | null
	slsOnly: boolean
	orgFlags: PlayerFlag[]
}
