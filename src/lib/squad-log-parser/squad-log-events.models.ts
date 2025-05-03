import * as SM from '@/lib/rcon/squad-models'
import * as dateFns from 'date-fns'
import * as dateFnsTz from 'date-fns-tz'
import { z } from 'zod'

const BaseEventProperties = {
	raw: z.string().trim(),
	time: z.date(),
	chainID: z.string(),
}

type EventMatcher<O extends object> = {
	regex: RegExp
	schema: z.ZodType<O>
	onMatch: (args: string[]) => O
}

export type SquadLogEvent = {
	type: string
}

const NewGameSchema = z.object({
	...BaseEventProperties,
	type: z.literal('NEW_GAME'),
	mapClassname: z.string().trim(),
	layerClassname: z.string().trim(),
})

export type NewGame = z.infer<typeof NewGameSchema>
export const NewGameEventMatcher: EventMatcher<NewGame> = {
	regex: /^\[([0-9.:-]+)]\[([ 0-9]*)]LogWorld: Bringing World \/([A-z]+)\/(?:Maps\/)?([A-z0-9-]+)\/(?:.+\/)?([A-z0-9-]+)(?:\.[A-z0-9-]+)/,
	schema: NewGameSchema,
	onMatch: (args: string[]) => ({
		type: 'NEW_GAME',
		raw: args[0],
		time: parseTimestamp(args[1]),
		chainID: args[2],
		mapClassname: args[3],
		layerClassname: args[5],
	}),
}

const RoundWinnerSchema = z.object({
	...BaseEventProperties,
	type: z.literal('ROUND_TEAM_OUTCOME'),
	winner: z.string(),
	layer: z.string(),
})
export type RoundWinner = z.infer<typeof RoundWinnerSchema>
export const RoundWinnerEventMatcher: EventMatcher<RoundWinner> = {
	regex: /^\[([0-9.:-]+)]\[([ 0-9]*)]LogGame: Winner: (.+) \(Layer: (.+)\)/,
	schema: RoundWinnerSchema,
	onMatch: (args: string[]) => ({
		type: 'ROUND_TEAM_OUTCOME',
		raw: args[0],
		time: parseTimestamp(args[1]),
		chainID: args[2],
		winner: args[3],
		layer: args[4],
	}),
}

export const RoundDecidedSchema = z.object({
	...BaseEventProperties,
	type: z.literal('ROUND_DECIDED'),
	team: SM.TeamIdSchema,
	subfaction: z.string(),
	faction: z.string(),
	action: z.enum(['won', 'lost']),
	tickets: z.number().int(),
	layer: z.string(),
	level: z.string(),
})

export type RoundDecided = z.infer<typeof RoundDecidedSchema>

export const RoundDecidedMatcher: EventMatcher<RoundDecided> = {
	schema: RoundDecidedSchema,
	regex:
		/^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquadGameEvents: Display: Team ([0-9]), (.*) \( ?(.*?) ?\) has (won|lost) the match with ([0-9]+) Tickets on layer (.*) \(level (.*)\)!/,
	onMatch: (args) => {
		return {
			type: 'ROUND_DECIDED',
			raw: args[0],
			time: parseTimestamp(args[1]),
			chainID: args[2],
			team: parseInt(args[3]) as 1 | 2,
			subfaction: args[4],
			faction: args[5],
			action: args[6] as 'won' | 'lost',
			tickets: parseInt(args[7]),
			layer: args[8],
			level: args[9],
		}
	},
}

export const RoundEndedSchema = z.object({
	...BaseEventProperties,
	type: z.literal('ROUND_ENDED'),
})

export type RoundEnded = z.infer<typeof RoundEndedSchema>
export const RoundEndedMatcher: EventMatcher<RoundEnded> = {
	schema: RoundEndedSchema,
	regex: /^\[([0-9.:-]+)]\[([ 0-9]*)]LogGameState: Match State Changed from InProgress to WaitingPostMatch/,
	onMatch: (args) => {
		return {
			type: 'ROUND_ENDED',
			raw: args[0],
			time: parseTimestamp(args[1]),
			chainID: args[2],
		}
	},
}

export type ToEventMap<E extends SquadLogEvent> = {
	[e in E['type']]: (evt: Extract<E, { type: e }>) => void
}

export type Event = NewGame | RoundWinner | RoundDecided | RoundEnded
export const EventMatchers = [NewGameEventMatcher, RoundWinnerEventMatcher, RoundDecidedMatcher, RoundEndedMatcher] as const

function parseTimestamp(raw: string) {
	const date = dateFns.parse(
		raw + 'Z',
		'yyyy.MM.dd-HH.mm.ss:SSSX',
		new Date(),
	)
	return date
}
