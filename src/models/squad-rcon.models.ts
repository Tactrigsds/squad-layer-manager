import type { AsyncResource } from '@/lib/async-resource'
import * as CD from '@/lib/ctx-def'
import type RconCore from '@/lib/rcon/core-rcon'
import type * as Rx from '@/lib/rxjs'
import * as CS from '@/models/context-shared'
import type * as Msgs from '@/models/messages.models'
import type * as SM from '@/models/squad.models'

export type Ctx = CS.Ctx & { squadRcon: Ctx.Payload } & Ctx.Rcon & CS.ServerId
export namespace Ctx {
	// a live rcon connection, without any of the per-server resources built on top of it
	export type Rcon = CS.Ctx & {
		rcon: RconCore
	}
	export const RconDef = CD.defCtx<Rcon>()(['rcon'], { name: 'rcon' })

	export type Payload = {
		rconEvent$: Rx.Observable<[CS.Otel, SM.RconEvents.Event]>

		layersStatus: AsyncResource<SM.LayerStatusRes, Ctx.Rcon & CS.AbortSignal>
		serverInfo: AsyncResource<SM.ServerInfoRes, Ctx.Rcon & CS.AbortSignal>
		// serverId: the roster is annotated with admin status, which is a per-server question (which admin lists apply)
		teams: AsyncResource<SM.TeamsRes, Ctx.Rcon & CS.ServerId & CS.AbortSignal>
	}
}

export type { WarnOptions, WarnOptionsBase } from '@/models/messages.models'

// What the warn utilities deliver: a Msg they translate themselves, or already-resolved strings from
// callsites not yet converted to the message vocabulary.
export type WarnInput = Msgs.Variants.Warnable | Msgs.WarnOptions<string>

// after the namespace, not beside the type: a namespace compiles to an IIFE, so Ctx.RconDef does not
// exist until that block has run. Types do not care about order, defs are values and do.
export const CtxDef = CD.defCtx<Ctx>()(['squadRcon'], { name: 'squadRcon', extends: [Ctx.RconDef, CS.ServerIdDef] })

export type ListPlayersRow = {
	playerID: number
	idsStr: string
	name: string
	teamId: number | null
	squadId: number | null
	isLeader: boolean
	role: string
}

const LIST_PLAYERS_KEYS_AFTER_NAME = ['Team ID', 'Squad ID', 'Is Leader', 'Role'] as const

// Reads the "Active Players" section of a ListPlayers response. Fields after Name are read by key, so a field the
// game adds (as the October 2026 update did for players in vehicles) does not stop a row from parsing. `unmatched`
// holds the rows in that section that could not be read.
export function parseListPlayers(body: string): { rows: ListPlayersRow[]; unmatched: string[] } {
	const rows: ListPlayersRow[] = []
	const unmatched: string[] = []
	let inActivePlayers = true
	for (const line of body.split('\n')) {
		if (line.startsWith('-----')) {
			inActivePlayers = line.includes('Active Players')
			continue
		}
		if (!inActivePlayers || line.trim() === '') continue
		const row = parseActivePlayerLine(line)
		if (row) rows.push(row)
		else unmatched.push(line)
	}
	return { rows, unmatched }
}

function parseActivePlayerLine(line: string): ListPlayersRow | null {
	const head = line.match(/^ID: (\d+) \| Online IDs:([^|]+)\| Name: (.*)$/)
	if (!head) return null
	const rest = head[3]

	// a name can contain " | ", so it ends at the first separator followed by a key known to come after it
	let nameEnd = -1
	for (const key of LIST_PLAYERS_KEYS_AFTER_NAME) {
		const idx = rest.indexOf(` | ${key}: `)
		if (idx !== -1 && (nameEnd === -1 || idx < nameEnd)) nameEnd = idx
	}
	if (nameEnd === -1) return null

	const fields = new Map<string, string>()
	for (const segment of rest.slice(nameEnd + 3).split(' | ')) {
		const sep = segment.indexOf(': ')
		if (sep === -1) continue
		fields.set(segment.slice(0, sep), segment.slice(sep + 2))
	}

	const teamId = fields.get('Team ID')
	const squadId = fields.get('Squad ID')
	const isLeader = fields.get('Is Leader')
	const role = fields.get('Role')
	if (teamId === undefined || !/^(\d|N\/A)$/.test(teamId)) return null
	if (squadId === undefined || !/^(\d+|N\/A)$/.test(squadId)) return null
	if (isLeader !== 'True' && isLeader !== 'False') return null
	if (!role) return null

	return {
		playerID: +head[1],
		idsStr: head[2],
		name: rest.slice(0, nameEnd),
		teamId: teamId === 'N/A' ? null : +teamId,
		squadId: squadId === 'N/A' ? null : +squadId,
		isLeader: isLeader === 'True',
		role,
	}
}
