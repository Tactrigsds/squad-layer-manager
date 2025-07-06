import * as CS from '@/models/context-shared'
import * as FB from '@/models/filter-builders'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as LQY from '@/models/layer-queries.models'
import * as MH from '@/models/match-history.models'
import * as C from '@/server/context'
import { ensureEnvSetup } from '@/server/env'
import { baseLogger, ensureLoggerSetup } from '@/server/logger'
import * as LayerDb from '@/server/systems/layer-db.server'
import { queryLayers } from '@/systems.shared/layer-queries.shared'
import { beforeAll, describe, expect, test } from 'vitest'
import * as BT from './balance-triggers.models'

let ctx!: CS.Log
let sampleLayers: L.KnownLayer[] = []

let terminatingLayers!: L.KnownLayer[]

beforeAll(async () => {
	ensureEnvSetup()
	ensureLoggerSetup()
	await LayerDb.setup({ skipHash: true })

	const baseQueryCtx = {
		log: baseLogger,
		layerDb: () => LayerDb.db,
		effectiveColsConfig: LC.getEffectiveColumnConfig(LayerDb.LAYER_DB_CONFIG),
		filters: [],
		recentMatches: [],
	}

	// Get RAAS layers
	const raasQuery = await queryLayers({
		input: {
			constraints: [LQY.filterToConstraint(FB.comp(FB.eq('Gamemode', 'RAAS')), 'only-raas')],
			previousLayerIds: [],
			pageSize: 10,
			pageIndex: 0,
		},
		ctx: baseQueryCtx,
	})
	sampleLayers = raasQuery.layers

	// Get Seed layers (terminating gamemode)
	const seedQuery = await queryLayers({
		input: {
			constraints: [LQY.filterToConstraint(FB.comp(FB.eq('Gamemode', 'Seed')), 'only-seed')],
			previousLayerIds: [],
			pageSize: 3,
			pageIndex: 0,
		},
		ctx: baseQueryCtx,
	})
	terminatingLayers = seedQuery.layers

	ctx = { log: baseLogger }
})

// Helper function to create mock match details
function createMockMatch(
	ordinal: number,
	outcome: MH.NormalizedMatchOutcome,
	terminating = false,
): MH.PostGameMatchDetails {
	return {
		status: 'post-game',
		historyEntryId: ordinal,
		ordinal,
		layerId: terminating ? terminatingLayers[ordinal % terminatingLayers.length].id : sampleLayers[ordinal % sampleLayers.length].id,
		lqItemId: undefined,
		layerSource: { type: 'unknown' },
		startTime: new Date(),
		endTime: new Date(),
		outcome: MH.getTeamDenormalizedOutcome({ ordinal }, outcome),
	}
}

// Helper to create a sequence of matches with specific outcomes
// This accounts for team normalization where teams swap sides between matches
function createMatchSequence(outcomes: Array<{ winner: 'teamA' | 'teamB' | 'draw'; margin: number }>): MH.PostGameMatchDetails[] {
	return outcomes.map((outcome, index) => {
		if (outcome.winner === 'draw') {
			return createMockMatch(index, { type: 'draw' })
		}
		const winnerTickets = outcome.margin
		const loserTickets = 0
		const shouldTeamAWin = outcome.winner === 'teamA'

		return createMockMatch(
			index,
			shouldTeamAWin
				? { type: 'teamA', teamATickets: winnerTickets, teamBTickets: loserTickets }
				: { type: 'teamB', teamATickets: loserTickets, teamBTickets: winnerTickets },
		)
	})
}

describe('Balance Triggers', () => {
	describe('150x2 Trigger', () => {
		const trigger = BT.TRIGGERS['150x2']

		test('triggers on 2 consecutive 150+ ticket wins', () => {
			const matches = createMatchSequence([
				{ winner: 'teamA', margin: 150 },
				{ winner: 'teamA', margin: 160 },
			])
			const input = trigger.resolveInput({ history: matches })
			const result = trigger.evaluate(ctx, input)

			expect(result).toMatchObject({
				code: 'triggered',
				strongerTeam: 'teamA',
			})
			expect(result).toHaveProperty('messageTemplate')
		})

		test('does not trigger on insufficient margin', () => {
			const matches = createMatchSequence([
				{ winner: 'teamA', margin: 140 },
				{ winner: 'teamA', margin: 160 },
			])
			const input = trigger.resolveInput({ history: matches })
			const result = trigger.evaluate(ctx, input)

			expect(result).toBeUndefined()
		})

		test('does not trigger on alternating winners', () => {
			const matches = createMatchSequence([
				{ winner: 'teamA', margin: 150 },
				{ winner: 'teamB', margin: 160 },
			])
			const input = trigger.resolveInput({ history: matches })
			const result = trigger.evaluate(ctx, input)

			expect(result).toBeUndefined()
		})

		test('does not trigger with draws', () => {
			const matches = createMatchSequence([
				{ winner: 'teamA', margin: 150 },
				{ winner: 'draw', margin: 0 },
			])
			const input = trigger.resolveInput({ history: matches })
			const result = trigger.evaluate(ctx, input)

			expect(result).toBeUndefined()
		})

		test('handles team normalization correctly', () => {
			// Test teamB consecutive wins across different ordinals
			const matches = createMatchSequence([
				{ winner: 'teamB', margin: 150 },
				{ winner: 'teamB', margin: 160 },
			])
			const input = trigger.resolveInput({ history: matches })
			const result = trigger.evaluate(ctx, input)

			expect(result).toMatchObject({
				code: 'triggered',
				strongerTeam: 'teamB',
			})
			expect(result).toHaveProperty('messageTemplate')
		})

		test('requires exactly 2 matches', () => {
			const matches = createMatchSequence([{ winner: 'teamA', margin: 150 }])
			const input = trigger.resolveInput({ history: matches })
			const result = trigger.evaluate(ctx, input)

			expect(result).toBeUndefined()
		})
	})

	describe('200x2 Trigger', () => {
		const trigger = BT.TRIGGERS['200x2']

		test('triggers on 2 consecutive 200+ ticket wins', () => {
			const matches = createMatchSequence([
				{ winner: 'teamA', margin: 200 },
				{ winner: 'teamA', margin: 210 },
			])
			const input = trigger.resolveInput({ history: matches })
			const result = trigger.evaluate(ctx, input)

			expect(result).toMatchObject({
				code: 'triggered',
				strongerTeam: 'teamA',
			})
			expect(result).toHaveProperty('messageTemplate')
		})

		test('does not trigger on 150+ but less than 200', () => {
			const matches = createMatchSequence([
				{ winner: 'teamA', margin: 190 },
				{ winner: 'teamA', margin: 180 },
			])
			const input = trigger.resolveInput({ history: matches })
			const result = trigger.evaluate(ctx, input)

			expect(result).toBeUndefined()
		})
	})

	describe('RWS5 Trigger', () => {
		const trigger = BT.TRIGGERS['RWS5']

		test('triggers on 5 consecutive wins', () => {
			const matches = createMatchSequence([
				{ winner: 'teamA', margin: 50 },
				{ winner: 'teamA', margin: 10 },
				{ winner: 'teamA', margin: 100 },
				{ winner: 'teamA', margin: 5 },
				{ winner: 'teamA', margin: 200 },
			])
			const input = trigger.resolveInput({ history: matches })
			const result = trigger.evaluate(ctx, input)

			expect(result).toMatchObject({
				code: 'triggered',
				strongerTeam: 'teamA',
			})
			expect(result).toHaveProperty('messageTemplate')
		})

		test('does not trigger on 4 consecutive wins', () => {
			const matches = createMatchSequence([
				{ winner: 'teamA', margin: 50 },
				{ winner: 'teamA', margin: 10 },
				{ winner: 'teamA', margin: 100 },
				{ winner: 'teamA', margin: 5 },
			])
			const input = trigger.resolveInput({ history: matches })
			const result = trigger.evaluate(ctx, input)

			expect(result).toBeUndefined()
		})

		test('does not trigger when streak is broken', () => {
			const matches = createMatchSequence([
				{ winner: 'teamA', margin: 50 },
				{ winner: 'teamA', margin: 10 },
				{ winner: 'teamB', margin: 100 },
				{ winner: 'teamA', margin: 5 },
				{ winner: 'teamA', margin: 200 },
			])
			const input = trigger.resolveInput({ history: matches })
			const result = trigger.evaluate(ctx, input)

			expect(result).toBeUndefined()
		})

		test('does not trigger with draws in sequence', () => {
			const matches = createMatchSequence([
				{ winner: 'teamA', margin: 50 },
				{ winner: 'teamA', margin: 10 },
				{ winner: 'draw', margin: 0 },
				{ winner: 'teamA', margin: 5 },
				{ winner: 'teamA', margin: 200 },
			])
			const input = trigger.resolveInput({ history: matches })
			const result = trigger.evaluate(ctx, input)

			expect(result).toBeUndefined()
		})

		test('handles teamB wins correctly', () => {
			const matches = createMatchSequence([
				{ winner: 'teamB', margin: 50 },
				{ winner: 'teamB', margin: 10 },
				{ winner: 'teamB', margin: 100 },
				{ winner: 'teamB', margin: 5 },
				{ winner: 'teamB', margin: 200 },
			])
			const input = trigger.resolveInput({ history: matches })
			const result = trigger.evaluate(ctx, input)

			expect(result).toMatchObject({
				code: 'triggered',
				strongerTeam: 'teamB',
			})
			expect(result).toHaveProperty('messageTemplate')
		})
	})

	describe('RAM3+ Trigger', () => {
		const trigger = BT.TRIGGERS['RAM3+']

		test('triggers on 3-game rolling average > 100', () => {
			const matches = createMatchSequence([
				{ winner: 'teamA', margin: 120 },
				{ winner: 'teamA', margin: 110 },
				{ winner: 'teamA', margin: 130 },
			])
			const input = trigger.resolveInput({ history: matches })
			const result = trigger.evaluate(ctx, input)

			expect(result).toMatchObject({
				code: 'triggered',
				strongerTeam: 'teamA',
			})
			expect(result).toHaveProperty('messageTemplate')
		})

		test('triggers on longer streak with max average', () => {
			const matches = createMatchSequence([
				{ winner: 'teamA', margin: 110 }, // 5-game avg: 100
				{ winner: 'teamA', margin: 105 }, // 4-game avg: 97.5
				{ winner: 'teamA', margin: 100 }, // 3-game avg: 95
				{ winner: 'teamA', margin: 95 }, // next previous game
				{ winner: 'teamA', margin: 90 }, // previous game
			])
			const input = trigger.resolveInput({ history: matches })
			const result = trigger.evaluate(ctx, input)

			expect(result).toMatchObject({
				code: 'triggered',
				strongerTeam: 'teamA',
			})
			expect(result).toHaveProperty('messageTemplate')
		})

		test('does not trigger on streak < 3', () => {
			const matches = createMatchSequence([
				{ winner: 'teamA', margin: 200 },
				{ winner: 'teamA', margin: 200 },
			])
			const input = trigger.resolveInput({ history: matches })
			const result = trigger.evaluate(ctx, input)

			expect(result).toBeUndefined()
		})

		test('does not trigger when average < 100', () => {
			const matches = createMatchSequence([
				{ winner: 'teamA', margin: 50 },
				{ winner: 'teamA', margin: 60 },
				{ winner: 'teamA', margin: 70 },
			])
			const input = trigger.resolveInput({ history: matches })
			const result = trigger.evaluate(ctx, input)

			expect(result).toBeUndefined()
		})

		test('does not trigger when streak is broken', () => {
			const matches = createMatchSequence([
				{ winner: 'teamA', margin: 150 },
				{ winner: 'teamB', margin: 150 },
				{ winner: 'teamA', margin: 150 },
			])
			const input = trigger.resolveInput({ history: matches })
			const result = trigger.evaluate(ctx, input)

			expect(result).toBeUndefined()
		})

		test('does not trigger when draw breaks streak', () => {
			// When a draw is encountered, the streak is broken and the trigger should not fire
			const matches = createMatchSequence([
				{ winner: 'teamA', margin: 150 },
				{ winner: 'teamA', margin: 150 },
				{ winner: 'draw', margin: 0 },
			])
			const input = trigger.resolveInput({ history: matches })
			const result = trigger.evaluate(ctx, input)

			expect(result).toBeUndefined()
		})
	})

	describe('Input Resolution', () => {
		test('filters out non-post-game matches', () => {
			const history: MH.MatchDetails[] = [
				{
					status: 'in-progress',
					historyEntryId: 999,
					ordinal: 0,
					layerId: sampleLayers[0].id,
					lqItemId: undefined,
					layerSource: { type: 'gameserver' },
					startTime: new Date(),
				},
				createMockMatch(1, { type: 'teamA', teamATickets: 400, teamBTickets: 200 }),
			]

			const trigger = BT.TRIGGERS['150x2']
			const input = trigger.resolveInput({ history })

			expect(input).toHaveLength(1)
			expect(input[0].status).toBe('post-game')
		})

		test('filters out terminating gamemodes', () => {
			const history: MH.MatchDetails[] = [
				createMockMatch(0, { type: 'teamA', teamATickets: 400, teamBTickets: 200 }, true),
				createMockMatch(1, { type: 'teamA', teamATickets: 400, teamBTickets: 200 }, true),
				createMockMatch(2, { type: 'teamA', teamATickets: 400, teamBTickets: 200 }, true),
				createMockMatch(3, { type: 'teamA', teamATickets: 400, teamBTickets: 200 }, true),
				createMockMatch(4, { type: 'teamA', teamATickets: 400, teamBTickets: 200 }, true),
				createMockMatch(5, { type: 'teamA', teamATickets: 400, teamBTickets: 200 }),
			]

			const trigger = BT.TRIGGERS['150x2']
			const input = trigger.resolveInput({ history })

			// Should only include the last match since terminating gamemodes break the session
			expect(input).toHaveLength(1)
			const layer = L.toLayer(input[0].layerId)
			expect(layer.Gamemode).toBe('RAAS')
		})

		test('respects maximum match count', () => {
			const history = createMatchSequence(
				Array(10).fill({ winner: 'teamA', margin: 150 }),
			)

			const trigger = BT.TRIGGERS['150x2']
			const input = trigger.resolveInput({ history })

			expect(input).toHaveLength(2) // 150x2 only needs last 2 matches
		})

		test('maintains chronological order', () => {
			const history = createMatchSequence([
				{ winner: 'teamA', margin: 100 },
				{ winner: 'teamB', margin: 150 },
				{ winner: 'teamA', margin: 200 },
			])

			const trigger = BT.TRIGGERS['RWS5']
			const input = trigger.resolveInput({ history })

			expect(input).toHaveLength(3)
			expect(input[0].ordinal).toBe(0)
			expect(input[1].ordinal).toBe(1)
			expect(input[2].ordinal).toBe(2)
		})
	})
})
