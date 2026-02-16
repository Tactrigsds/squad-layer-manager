import { z } from 'zod'

// ---- JSON:API shared shapes ----

const JsonApiResourceRef = z.object({
	type: z.string(),
	id: z.string(),
})

// ---- Player flags ----

const FlagPlayerInclude = z.object({
	type: z.literal('flagPlayer'),
	id: z.string(),
	relationships: z.object({
		playerFlag: z.object({
			data: JsonApiResourceRef,
		}),
		player: z.object({
			data: JsonApiResourceRef,
		}).optional(),
		organization: z.object({
			data: JsonApiResourceRef,
		}).optional(),
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

// ---- GET /players?include=identifier,flagPlayer,playerFlag (list) ----

const IdentifierInclude = z.object({
	type: z.literal('identifier'),
	id: z.string(),
	attributes: z.object({
		type: z.string(),
		identifier: z.string(),
	}),
	relationships: z.object({
		player: z.object({
			data: JsonApiResourceRef,
		}),
	}).optional(),
})

const PlayerServerRef = z.object({
	type: z.literal('server'),
	id: z.string(),
	meta: z.object({
		timePlayed: z.number().nullable().optional(),
	}).optional(),
})

export const PlayerListResponse = z.object({
	data: z.array(z.object({
		type: z.literal('player'),
		id: z.string(),
		relationships: z.object({
			servers: z.object({
				data: z.array(PlayerServerRef).optional(),
			}).optional(),
		}).optional(),
	})),
	included: z.array(z.discriminatedUnion('type', [
		IdentifierInclude,
		FlagPlayerInclude,
		PlayerFlagInclude,
	])).nullable().optional(),
	links: z.object({
		next: z.string().nullable().optional(),
		prev: z.string().nullable().optional(),
	}).nullable().optional(),
})

// ---- /servers?filter[organizations]=... ----

export const ServersResponse = z.object({
	data: z.array(z.object({
		type: z.literal('server'),
		id: z.string(),
		attributes: z.object({
			name: z.string(),
		}),
	})),
})

// ---- Composite types used by server + client ----

export type PlayerFlagsAndProfile = {
	flags: PlayerFlag[]
	bmPlayerId: string
	profileUrl: string
	hoursPlayed: number
}

export type PublicPlayerBmData = Record<string, PlayerFlagsAndProfile>
