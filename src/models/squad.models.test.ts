import * as SM from '@/models/squad.models'
import { describe, expect, it } from 'vitest'

async function* toChunks(...chunks: string[]): AsyncGenerator<string> {
	for (const chunk of chunks) yield chunk
}

async function collect(log: string, errors: Error[] = []) {
	const results: (SM.LogEvents.AnyChainEvent | SM.LogEvents.NonChainEvent)[] = []
	for await (const [event] of SM.LogEvents.parse(toChunks(log + '\n'), errors)) {
		if (event !== null) results.push(event)
	}
	return results
}

// --- Sample log lines ---

const NEW_GAME =
	'[2025.11.19-18.16.42:091][  0]LogWorld: Bringing World /Al_Basrah/Maps/Gameplay_Layers/AlBasrah_AAS_v1.AlBasrah_AAS_v1 up for play'

const PLAYER_CONNECTED =
	'[2025.11.19-18.18.26:148][549]LogSquad: PostLogin: NewPlayer: BP_PlayerController_C /Game/Maps/Level.PersistentLevel.Logano_Stefano (IP: 192.168.1.1 | Online IDs: EOS: 0002abc123def456789abc123def4567)'
const PLAYER_JOIN_SUCCEEDED = '[2025.11.19-18.18.26:151][549]LogNet: Join succeeded: Logano Stefano'
const PLAYER_ADDED_TO_TEAM = '[2025.11.19-18.18.26:152][549]LogSquad: Player  Logano Stefano has been added to Team 1'
const PLAYER_RESTARTED =
	'[2025.11.19-18.18.26:153][549]LogSquadTrace: [DedicatedServer]RestartPlayer(): On Server PC=Logano_Stefano Spawn=nullptr DeployRole=MEI_Rifleman_01'
const JOIN_CHAIN = [PLAYER_CONNECTED, PLAYER_JOIN_SUCCEEDED, PLAYER_ADDED_TO_TEAM, PLAYER_RESTARTED].join('\n')

// New Squad format: complex map path, generic numbered controller, steam ID alongside EOS, no PLAYER_ADDED_TO_TEAM, PLAYER_RESTARTED before PLAYER_JOIN_SUCCEEDED
const PLAYER_CONNECTED_NEW =
	'[2026.04.17-18.11.29:556][237]LogSquad: PostLogin: NewPlayer: BP_PlayerController_C /Game/Maps/Narva/Gameplay_Layers/Narva_AAS_v2.Narva_AAS_v2:PersistentLevel.BP_PlayerController_C_2147444576 (IP: 75.155.191.37 | Online IDs: EOS: 000249a430574933aefd9bbc9a8f2f37 steam: 76561198052229202)'
const PLAYER_RESTARTED_NEW =
	'[2026.04.17-18.11.29:556][237]LogSquadTrace: [DedicatedServer]RestartPlayer(): On Server PC=grey275 Spawn=nullptr DeployRole=AFU_Rifleman_13'
const PLAYER_JOIN_SUCCEEDED_NEW = '[2026.04.17-18.11.29:556][237]LogNet: Join succeeded: grey275'
const JOIN_CHAIN_NEW = [PLAYER_CONNECTED_NEW, PLAYER_RESTARTED_NEW, PLAYER_JOIN_SUCCEEDED_NEW].join('\n')

const DETERMINE_MATCH_WINNER =
	'[2025.11.19-18.19.04:262][979]LogSquadTrace: [DedicatedServer]DetermineMatchWinner(): Irregular Armored Squadron won on Al Basrah'
const ROUND_DECIDED =
	'[2025.11.19-18.19.04:264][979]LogSquadGameEvents: Display: Team 1, Alpha ( CAF ) has won the match with 150 Tickets on layer Al Basrah AAS v1 (level Al Basrah)!'
const ROUND_DECIDED_LOSER =
	'[2025.11.19-18.19.04:264][979]LogSquadGameEvents: Display: Team 2, MEA ( MEA ) has lost the match with 0 Tickets on layer Al Basrah AAS v1 (level Al Basrah)!'
const DETERMINE_MATCH_WINNER_DRAW =
	'[2025.11.19-18.19.04:262][979]LogSquadTrace: [DedicatedServer]DetermineMatchWinner(): The game was a draw on Al Basrah'
const ROUND_DECIDED_DRAW =
	'[2025.11.19-18.19.04:264][979]LogSquadGameEvents: Display: Team -1,  (  ) has won the match with -1 Tickets on layer Al Basrah AAS v1 (level Al Basrah)!'
const ROUND_DECIDED_LOSER_DRAW =
	'[2025.11.19-18.19.04:264][979]LogSquadGameEvents: Display: Team -1,  (  ) has lost the match with -1 Tickets on layer Al Basrah AAS v1 (level Al Basrah)!'
const ROUND_CHAIN = [DETERMINE_MATCH_WINNER, ROUND_DECIDED, ROUND_DECIDED_LOSER].join('\n')
const ROUND_DRAW_CHAIN = [DETERMINE_MATCH_WINNER, DETERMINE_MATCH_WINNER_DRAW, ROUND_DECIDED_DRAW, ROUND_DECIDED_LOSER_DRAW].join('\n')

// Admin-ended round: no ROUND_DECIDED lines, chain terminated by chainID change
const DETERMINE_MATCH_WINNER_ADMIN =
	'[2026.04.17-19.29.13:107][427]LogSquadTrace: [DedicatedServer]DetermineMatchWinner(): 31st Marine Expeditionary Unit won on Kohat Toi'
const DETERMINE_MATCH_WINNER_DRAW_ADMIN =
	'[2026.04.17-19.29.13:107][427]LogSquadTrace: [DedicatedServer]DetermineMatchWinner(): The game was a draw on Kohat Toi'
const ROUND_ENDED_ADMIN = '[2026.04.17-19.29.13:108][427]LogGameState: Match State Changed from InProgress to WaitingPostMatch'
const ADMIN_MATCH_ENDED = '[2026.04.17-19.29.13:108][427]LogSquad: ADMIN COMMAND: Match ended from RCON'
// A subsequent event with a different chainID forces the chain to complete
const NEXT_TICK_EVENT =
	'[2026.04.17-19.29.15:000][428]LogWorld: Bringing World /Kohat/Maps/Gameplay_Layers/Kohat_RAAS_v1.Kohat_RAAS_v1 up for play'
const ROUND_ADMIN_CHAIN = [
	DETERMINE_MATCH_WINNER_ADMIN,
	DETERMINE_MATCH_WINNER_DRAW_ADMIN,
	ROUND_ENDED_ADMIN,
	ADMIN_MATCH_ENDED,
	NEXT_TICK_EVENT,
].join('\n')

const PLAYER_DISCONNECTED =
	'[2026.04.17-18.35.14:535][115]LogNet: UChannel::Close: Sending CloseBunch. ChIndex == 0. Name: [UChannel] ChIndex: 0, Closing: 0 [UNetConnection] RemoteAddr: 75.155.191.37:51909, Name: RedpointEOSIpNetConnection_2147440814, Driver: Name:GameNetDriver Def:GameNetDriver RedpointEOSNetDriver_2147482371, IsServer: YES, PC: BP_PlayerController_C_2147440788, Owner: BP_PlayerController_C_2147440788, UniqueId: RedpointEOS:000249a430574933aefd9bbc9a8f2f37'

const ADMIN_BROADCAST_SINGLE = '[2025.11.19-18.18.26:151][549]LogSquad: ADMIN COMMAND: Message broadcasted <Hello world> from RCON'
const ADMIN_BROADCAST_MULTILINE =
	'[2025.11.19-18.18.26:151][549]LogSquad: ADMIN COMMAND: Message broadcasted <Hello world\nFactions: RGF+CombinedArms AFU+CombinedArms> from RCON'

// --- Tests ---

describe('LogEvents.parse', () => {
	describe('PLAYER_DISCONNECTED', () => {
		it('parses disconnect with verbose Driver field and generic controller name', async () => {
			const events = await collect(PLAYER_DISCONNECTED)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				type: 'PLAYER_DISCONNECTED',
				ip: '75.155.191.37',
				playerIds: expect.objectContaining({
					eos: '000249a430574933aefd9bbc9a8f2f37',
					playerController: 'BP_PlayerController_C_2147440788',
				}),
			})
		})
	})

	describe('admin broadcast', () => {
		it('parses a single-line broadcast', async () => {
			const events = await collect(ADMIN_BROADCAST_SINGLE)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({ type: 'ADMIN_BROADCAST', message: 'Hello world', from: 'RCON' })
		})

		it('parses a multiline broadcast where the continuation line matches a preamble pattern', async () => {
			const events = await collect(ADMIN_BROADCAST_MULTILINE)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				type: 'ADMIN_BROADCAST',
				message: 'Hello world\nFactions: RGF+CombinedArms AFU+CombinedArms',
				from: 'RCON',
			})
		})
	})

	describe('non-chain events', () => {
		it('yields a non-chain event individually', async () => {
			const events = await collect(NEW_GAME)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({ type: 'NEW_GAME' })
		})

		it('yields multiple non-chain events in order', async () => {
			const events = await collect([NEW_GAME, NEW_GAME].join('\n'))
			expect(events).toHaveLength(2)
			expect(events[0]).toMatchObject({ type: 'NEW_GAME' })
			expect(events[1]).toMatchObject({ type: 'NEW_GAME' })
		})

		it('yields an UNKNOWN event for unrecognized log lines', async () => {
			const errors: Error[] = []
			const events = await collect(
				'[2025.11.19-18.18.26:000][  0]LogUnknown: something unrecognized',
				errors,
			)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({ type: 'UNKNOWN' })
			expect(errors).toHaveLength(0)
		})
	})

	describe('PLAYER_CONNECTED_CHAIN', () => {
		it('groups all four events into a single chain event', async () => {
			const events = await collect(JOIN_CHAIN)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				type: 'PLAYER_CONNECTED_CHAIN',
				events: {
					PLAYER_CONNECTED: expect.objectContaining({ type: 'PLAYER_CONNECTED' }),
					PLAYER_JOIN_SUCCEEDED: expect.objectContaining({ type: 'PLAYER_JOIN_SUCCEEDED' }),
					PLAYER_ADDED_TO_TEAM: expect.objectContaining({ type: 'PLAYER_ADDED_TO_TEAM', teamId: 1 }),
					PLAYER_RESTARTED: expect.objectContaining({
						type: 'PLAYER_RESTARTED',
						playerController: 'Logano_Stefano',
					}),
				},
			})
		})

		it('handles two sequential join chains with different chainIDs', async () => {
			const events = await collect([JOIN_CHAIN, JOIN_CHAIN_NEW].join('\n'))
			expect(events).toHaveLength(2)
			expect(events[0]).toMatchObject({ type: 'PLAYER_CONNECTED_CHAIN' })
			expect(events[1]).toMatchObject({ type: 'PLAYER_CONNECTED_CHAIN' })
		})

		it('silently ignores unrecognized events with the same chainID mid-chain', async () => {
			const errors: Error[] = []
			// An unrecognized log line sharing chainID 549 appears between chain events — should be silently dropped
			const unknownSameChain = '[2025.11.19-18.18.26:150][549]LogSomething: Some unrecognized line'
			const events = await collect(
				[PLAYER_CONNECTED, PLAYER_JOIN_SUCCEEDED, unknownSameChain, PLAYER_ADDED_TO_TEAM, PLAYER_RESTARTED].join('\n'),
				errors,
			)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({ type: 'PLAYER_CONNECTED_CHAIN' })
			expect(errors).toHaveLength(0)
		})

		it('pushes error for incomplete chain at end of stream', async () => {
			const errors: Error[] = []
			const events = await collect(
				[PLAYER_CONNECTED, PLAYER_JOIN_SUCCEEDED, PLAYER_ADDED_TO_TEAM].join('\n'),
				errors,
			)
			expect(events).toHaveLength(0)
			expect(errors).toHaveLength(1)
			expect(errors[0].message).toMatch(/PLAYER_CONNECTED_CHAIN/)
		})

		it('pushes error and restarts when chain-start event is repeated mid-chain', async () => {
			const errors: Error[] = []
			// Second PLAYER_CONNECTED restarts the chain; the first is abandoned
			const events = await collect(
				[PLAYER_CONNECTED, PLAYER_JOIN_SUCCEEDED, PLAYER_CONNECTED, PLAYER_JOIN_SUCCEEDED, PLAYER_ADDED_TO_TEAM, PLAYER_RESTARTED].join(
					'\n',
				),
				errors,
			)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({ type: 'PLAYER_CONNECTED_CHAIN' })
			expect(errors).toHaveLength(1)
			expect(errors[0].message).toMatch(/restarted before completion/i)
		})

		it('parses new format: steam ID, generic controller, PLAYER_RESTARTED before PLAYER_JOIN_SUCCEEDED, no PLAYER_ADDED_TO_TEAM', async () => {
			const events = await collect(JOIN_CHAIN_NEW)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				type: 'PLAYER_CONNECTED_CHAIN',
				events: {
					PLAYER_CONNECTED: expect.objectContaining({
						playerIds: expect.objectContaining({
							eos: '000249a430574933aefd9bbc9a8f2f37',
							steam: '76561198052229202',
							playerController: 'BP_PlayerController_C_2147444576',
						}),
					}),
					PLAYER_RESTARTED: expect.objectContaining({ playerController: 'grey275', deployRole: 'AFU_Rifleman_13' }),
					PLAYER_JOIN_SUCCEEDED: expect.objectContaining({ player: expect.objectContaining({ usernameNoTag: 'grey275' }) }),
				},
			})
		})

		it('yields a non-initiator chain event as a standalone event when no chain is in progress', async () => {
			const errors: Error[] = []
			const events = await collect(PLAYER_ADDED_TO_TEAM, errors)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({ type: 'PLAYER_ADDED_TO_TEAM' })
			expect(errors).toHaveLength(0)
		})

		it('pushes error for abandoned chain when a different chain starts with a new chainID', async () => {
			const errors: Error[] = []
			// DETERMINE_MATCH_WINNER (chainID 979) starts a different chain while join chain (chainID 549) is in progress
			const events = await collect(
				[PLAYER_CONNECTED, PLAYER_JOIN_SUCCEEDED, DETERMINE_MATCH_WINNER, ROUND_DECIDED, ROUND_DECIDED_LOSER].join('\n'),
				errors,
			)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({ type: 'ROUND_ENDED_CHAIN' })
			expect(errors).toHaveLength(1)
			expect(errors[0].message).toMatch(/PLAYER_CONNECTED_CHAIN/)
		})
	})

	describe('ROUND_ENDED_CHAIN', () => {
		it('groups three events into a single chain event', async () => {
			const events = await collect(ROUND_CHAIN)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				type: 'ROUND_ENDED_CHAIN',
				events: {
					DETERMINE_MATCH_WINNER: expect.objectContaining({ type: 'DETERMINE_MATCH_WINNER', winner: 'Irregular Armored Squadron' }),
					ROUND_DECIDED_WINNER: expect.objectContaining({ type: 'ROUND_DECIDED_WINNER', team: 1, tickets: 150 }),
					ROUND_DECIDED_LOSER: expect.objectContaining({ type: 'ROUND_DECIDED_LOSER', team: 2, tickets: 0 }),
				},
			})
		})

		it('completes on chainID change when no ROUND_DECIDED lines present (admin-ended match)', async () => {
			const errors: Error[] = []
			const events = await collect(ROUND_ADMIN_CHAIN, errors)
			expect(errors).toHaveLength(0)
			expect(events).toHaveLength(2)
			expect(events[0]).toMatchObject({
				type: 'ROUND_ENDED_CHAIN',
				events: {
					DETERMINE_MATCH_WINNER: expect.objectContaining({ type: 'DETERMINE_MATCH_WINNER' }),
				},
			})
			expect(events[0]).not.toHaveProperty('events.ROUND_DECIDED_WINNER')
			expect(events[1]).toMatchObject({ type: 'NEW_GAME' })
		})

		it('handles a draw (team -1), dropping the interleaved draw DetermineMatchWinner line', async () => {
			const errors: Error[] = []
			const events = await collect(ROUND_DRAW_CHAIN, errors)
			expect(errors).toHaveLength(0)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				type: 'ROUND_ENDED_CHAIN',
				events: {
					DETERMINE_MATCH_WINNER: expect.objectContaining({ type: 'DETERMINE_MATCH_WINNER' }),
					ROUND_DECIDED_WINNER: expect.objectContaining({ type: 'ROUND_DECIDED_WINNER', team: -1, tickets: -1 }),
					ROUND_DECIDED_LOSER: expect.objectContaining({ type: 'ROUND_DECIDED_LOSER', team: -1, tickets: -1 }),
				},
			})
		})
	})

	describe('mixed events', () => {
		it('yields non-chain events before and after a chain', async () => {
			const events = await collect([NEW_GAME, JOIN_CHAIN, NEW_GAME].join('\n'))
			expect(events).toHaveLength(3)
			expect(events[0]).toMatchObject({ type: 'NEW_GAME' })
			expect(events[1]).toMatchObject({ type: 'PLAYER_CONNECTED_CHAIN' })
			expect(events[2]).toMatchObject({ type: 'NEW_GAME' })
		})

		it('yields two different chain types sequentially', async () => {
			const events = await collect([JOIN_CHAIN, ROUND_CHAIN].join('\n'))
			expect(events).toHaveLength(2)
			expect(events[0]).toMatchObject({ type: 'PLAYER_CONNECTED_CHAIN' })
			expect(events[1]).toMatchObject({ type: 'ROUND_ENDED_CHAIN' })
		})
	})
})
