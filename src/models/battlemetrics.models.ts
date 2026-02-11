import { z } from 'zod'

// ---- JSON:API shared shapes ----

const JsonApiResourceRef = z.object({
	type: z.string(),
	id: z.string(),
})

const JsonApiMeta = z.object({
	total: z.number().nullable().optional(),
}).nullable().optional()

// ---- /players/match ----

export const PlayerMatchResponse = z.object({
	data: z.array(z.object({
		type: z.literal('identifier'),
		id: z.string(),
		relationships: z.object({
			player: z.object({
				data: JsonApiResourceRef,
			}),
		}),
	})),
})

// ---- /players/{id}?include=flagPlayer,playerFlag ----

const FlagPlayerInclude = z.object({
	type: z.literal('flagPlayer'),
	id: z.string(),
	relationships: z.object({
		playerFlag: z.object({
			data: JsonApiResourceRef,
		}),
	}).nullable().optional(),
})

export const PlayerFlagAttributes = z.object({
	name: z.string().nullable(),
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

export const PlayerWithFlagsResponse = z.object({
	data: z.object({
		type: z.literal('player'),
		id: z.string(),
	}),
	included: z.array(z.discriminatedUnion('type', [FlagPlayerInclude, PlayerFlagInclude])).nullable().optional(),
})

// ---- /servers?filter[organizations]=... ----

export const ServersResponse = z.object({
	data: z.array(z.object({
		type: z.literal('server'),
		id: z.string(),
	})),
})

// ---- /players/{id}/servers/{serverId} ----

export const PlayerServerResponse = z.object({
	data: z.object({
		attributes: z.object({
			timePlayed: z.number().nullable().optional(),
		}),
	}),
})

// ---- /bans?filter[player]=... ----

export const BansResponse = z.object({
	data: z.array(z.object({
		type: z.literal('ban'),
		id: z.string(),
	})),
	meta: JsonApiMeta,
})

// ---- /players/{id}/relationships/notes ----

export const NotesResponse = z.object({
	data: z.array(z.object({
		type: z.literal('playerNote'),
		id: z.string(),
	})),
	meta: JsonApiMeta,
})
