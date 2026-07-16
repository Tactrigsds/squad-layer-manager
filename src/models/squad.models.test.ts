import { matchLog } from '@/lib/log-parsing'
import * as SM from '@/models/squad.models'
import { describe, expect, it } from 'vitest'

async function* toChunks(...chunks: string[]): AsyncGenerator<string> {
	for (const chunk of chunks) yield chunk
}

async function collect(log: string, errors: Error[] = []) {
	const results: (SM.LogEvents.AnyChainEvent | SM.LogEvents.NonChainEvent)[] = []
	for await (const event of SM.LogEvents.parseLogStream(toChunks(log + '\n'), errors)) {
		if (event !== null) results.push(event)
	}
	return results
}

// --- Sample log lines ---

const NEW_GAME =
	'[2025.11.19-18.16.42:091][  0]LogWorld: Bringing World /Al_Basrah/Maps/Gameplay_Layers/AlBasrah_AAS_v1.AlBasrah_AAS_v1 up for play'

const PLAYER_CONNECTED =
	'[2025.11.19-18.18.26:148][549]LogSquad: PostLogin: NewPlayer: BP_PlayerController_C /Game/Maps/Level.PersistentLevel.Logano_Stefano (IP: 203.0.113.21 | Online IDs: EOS: 0002abc123def456789abc123def4567)'
const PLAYER_JOIN_SUCCEEDED = '[2025.11.19-18.18.26:151][549]LogNet: Join succeeded: Logano Stefano'
const PLAYER_ADDED_TO_TEAM = '[2025.11.19-18.18.26:152][549]LogSquad: Player  Logano Stefano has been added to Team 1'
const PLAYER_RESTARTED =
	'[2025.11.19-18.18.26:153][549]LogSquadTrace: [DedicatedServer]RestartPlayer(): On Server PC=Logano_Stefano Spawn=nullptr DeployRole=MEI_Rifleman_01'
const JOIN_CHAIN = [PLAYER_CONNECTED, PLAYER_JOIN_SUCCEEDED, PLAYER_ADDED_TO_TEAM, PLAYER_RESTARTED].join('\n')

// New Squad format: complex map path, generic numbered controller, steam ID alongside EOS, no PLAYER_ADDED_TO_TEAM, PLAYER_RESTARTED before PLAYER_JOIN_SUCCEEDED
const PLAYER_CONNECTED_NEW =
	'[2026.04.17-18.11.29:556][237]LogSquad: PostLogin: NewPlayer: BP_PlayerController_C /Game/Maps/Narva/Gameplay_Layers/Narva_AAS_v2.Narva_AAS_v2:PersistentLevel.BP_PlayerController_C_2147444576 (IP: 203.0.113.20 | Online IDs: EOS: 000249a430574933aefd9bbc9a8f2f37 steam: 76561198052229202)'
const PLAYER_RESTARTED_NEW =
	'[2026.04.17-18.11.29:556][237]LogSquadTrace: [DedicatedServer]RestartPlayer(): On Server PC=grey275 Spawn=nullptr DeployRole=AFU_Rifleman_13'
const PLAYER_JOIN_SUCCEEDED_NEW = '[2026.04.17-18.11.29:556][237]LogNet: Join succeeded: grey275'
const JOIN_CHAIN_NEW = [PLAYER_CONNECTED_NEW, PLAYER_RESTARTED_NEW, PLAYER_JOIN_SUCCEEDED_NEW].join('\n')

const ROUND_ENDED_MAIN = '[2025.11.19-18.19.04:265][979]LogGameState: Match State Changed from InProgress to WaitingPostMatch'
const ROUND_DECIDED =
	'[2025.11.19-18.19.04:264][979]LogSquadGameEvents: Display: Team 1, Alpha ( CAF ) has won the match with 150 Tickets on layer Al Basrah AAS v1 (level Al Basrah)!'
const ROUND_DECIDED_LOSER =
	'[2025.11.19-18.19.04:264][979]LogSquadGameEvents: Display: Team 2, MEA ( MEA ) has lost the match with 0 Tickets on layer Al Basrah AAS v1 (level Al Basrah)!'
const ROUND_DECIDED_DRAW =
	'[2025.11.19-18.19.04:264][979]LogSquadGameEvents: Display: Team -1,  (  ) has won the match with -1 Tickets on layer Al Basrah AAS v1 (level Al Basrah)!'
const ROUND_DECIDED_LOSER_DRAW =
	'[2025.11.19-18.19.04:264][979]LogSquadGameEvents: Display: Team -1,  (  ) has lost the match with -1 Tickets on layer Al Basrah AAS v1 (level Al Basrah)!'
const ROUND_CHAIN = [ROUND_ENDED_MAIN, ROUND_DECIDED, ROUND_DECIDED_LOSER].join('\n')
const ROUND_DRAW_CHAIN = [ROUND_ENDED_MAIN, ROUND_DECIDED_DRAW, ROUND_DECIDED_LOSER_DRAW].join('\n')

// Admin-ended round via RCON: no ROUND_DECIDED lines
const DETERMINE_MATCH_WINNER_ADMIN =
	'[2026.04.17-19.29.13:107][427]LogSquadTrace: [DedicatedServer]DetermineMatchWinner(): 31st Marine Expeditionary Unit won on Kohat Toi'
const DETERMINE_MATCH_WINNER_DRAW_ADMIN =
	'[2026.04.17-19.29.13:107][427]LogSquadTrace: [DedicatedServer]DetermineMatchWinner(): The game was a draw on Kohat Toi'
const ROUND_ENDED_ADMIN = '[2026.04.17-19.29.13:108][427]LogGameState: Match State Changed from InProgress to WaitingPostMatch'
const RCON_MATCH_ENDED = '[2026.04.17-19.29.13:108][427]LogSquad: ADMIN COMMAND: Match ended from RCON'
// A subsequent event with a different chainID forces the chain to complete
const NEXT_TICK_EVENT =
	'[2026.04.17-19.29.15:000][428]LogWorld: Bringing World /Kohat/Maps/Gameplay_Layers/Kohat_RAAS_v1.Kohat_RAAS_v1 up for play'
const ROUND_ADMIN_CHAIN = [
	DETERMINE_MATCH_WINNER_ADMIN,
	DETERMINE_MATCH_WINNER_DRAW_ADMIN,
	ROUND_ENDED_ADMIN,
	RCON_MATCH_ENDED,
	NEXT_TICK_EVENT,
].join('\n')

// Admin-ended round via player (in-game admin panel)
const ADMIN_MATCH_ENDED_PLAYER =
	'[2026.05.20-16.39.45:908][508]LogSquad: ADMIN COMMAND: Match ended from player 0. [Online IDs= EOS: 000249a430574933aefd9bbc9a8f2f37 steam: 76561198052229202]  grey275'
const ROUND_ENDED_ADMIN_PLAYER = '[2026.05.20-16.39.45:909][508]LogGameState: Match State Changed from InProgress to WaitingPostMatch'
const ROUND_ADMIN_PLAYER_CHAIN = [ADMIN_MATCH_ENDED_PLAYER, ROUND_ENDED_ADMIN_PLAYER, NEXT_TICK_EVENT].join('\n')
const ADMIN_LAYER_CHANGED_PLAYER_CHAIN = `
[2026.05.20-17.08.43:853][242]LogSquad: ADMIN COMMAND: Change layer to AlBasrah_AAS_v1 RGF+CombinedArms MEI+CombinedArms from player 0. [Online IDs= EOS: 000249a430574933aefd9bbc9a8f2f37 steam: 76561198052229202]   grey275
[2026.05.20-17.08.43:853][242]LogGameMode: Display: Match State Changed from InProgress to WaitingPostMatch
[2026.05.20-17.08.43:853][242]LogSquadTrace: [DedicatedServer]DetermineMatchWinner(): 1st Tank Brigade won on Kohat Toi
[2026.05.20-17.08.43:853][242]LogSquadTrace: [DedicatedServer]DetermineMatchWinner(): The game was a draw on Kohat Toi
[2026.05.20-17.08.43:855][242]LogGameState: Match State Changed from InProgress to WaitingPostMatch
`.trim()

// [2026.05.20-21.59.52:083][ 77]LogSquad: ADMIN COMMAND: Change layer to Gorodok_AAS_v1 RGF USA from player 0. [Online IDs= EOS: 000249a430574933aefd9bbc9a8f2f37 steam: 76561198052229202]  grey275
// [2026.05.20-21.59.52:083][ 77]LogGameMode: Display: Match State Changed from InProgress to WaitingPostMatch
// [2026.05.20-21.59.52:083][ 77]LogSquadTrace: [DedicatedServer]DetermineMatchWinner(): 1st Infantry Division won on Al Basrah
// [2026.05.20-21.59.52:083][ 77]LogSquadTrace: [DedicatedServer]DetermineMatchWinner(): The game was a draw on Al Basrah
// [2026.05.20-21.59.52:085][ 77]LogGameState: Match State Changed from InProgress to WaitingPostMatch

const PLAYER_DISCONNECTED =
	'[2026.07.12-19.05.54:142][418]LogNet: UNetDriver::RemoveClientConnection - Removed address 203.0.113.22:60763 from MappedClientConnections for: [UNetConnection] RemoteAddr: 203.0.113.22:60763, Name: RedpointEOSIpNetConnection_2147249600, Driver: Name:GameNetDriver Def:GameNetDriver RedpointEOSNetDriver_2147482319, IsServer: YES, PC: BP_PlayerController_C_2147247660, Owner: BP_PlayerController_C_2147247660, UniqueId: RedpointEOS:00026fd6fefb44a3a86b91925c95a40f'

// Same RemoveClientConnection shape but on a BeaconNetDriver (join-queue) connection: PC NULL,
// SQJoinBeaconClient owner. Must NOT be parsed as a real disconnect.
const BEACON_DISCONNECT =
	'[2026.07.02-08.26.47:884][437]LogNet: UNetDriver::RemoveClientConnection - Removed address 203.0.113.2:45870 from MappedClientConnections for: [UNetConnection] RemoteAddr: 203.0.113.2:45870, Name: RedpointEOSIpNetConnection_2147480829, Driver: Name:RedpointEOSNetDriver_2147481756 Def:BeaconNetDriver RedpointEOSNetDriver_2147481756, IsServer: YES, PC: NULL, Owner: SQJoinBeaconClient_2147480824, UniqueId: RedpointEOS:00023e0ccf9a4321bc99f7ca0e466f5a'

const ADMIN_BROADCAST_SINGLE = '[2025.11.19-18.18.26:151][549]LogSquad: ADMIN COMMAND: Message broadcasted <Hello world> from RCON'
const ADMIN_BROADCAST_MULTILINE =
	'[2025.11.19-18.18.26:151][549]LogSquad: ADMIN COMMAND: Message broadcasted <Hello world\nFactions: RGF+CombinedArms AFU+CombinedArms> from RCON'

const PLAYER_WOUNDED =
	'[2026.04.27-23.33.47:250][332]LogSquadTrace: [DedicatedServer]Wound(): Player:RaT I Gangry KillingDamage=0.000000 from BP_PlayerController_C_2146093177 (Online IDs: EOS: 00029ce874284d2ba0199af5dd36a199 steam: 76561198397430155 | Controller ID: BP_PlayerController_C_2146093177) caused by BP_Soldier_USMC_Rifleman1_Woodland_C'

// Deployable/fortification weapon token with no _C suffix (attacker INVALID here, but exercises the verbatim-token path)
const WOUND_FENCE =
	'[2026.07.02-22.36.19:324][287]LogSquadTrace: [DedicatedServer]Wound(): Player:  vicctoorr KillingDamage=7.000000 from BP_PlayerController_C_2146099999 (Online IDs: EOS: 00029ce874284d2ba0199af5dd36a199 steam: 76561198397430155 | Controller ID: BP_PlayerController_C_2146099999) caused by Fence58_229'

// Outright kill with a known attacker but the killing weapon actor already gone (`caused by nullptr`)
const DIED_NULLPTR_WEAPON =
	'[2026.07.02-12.51.55:354][635]LogSquadTrace: [DedicatedServer]Die(): Player: WildChildCao KillingDamage=100.000000 from BP_PlayerController_C_2147443815 (Online IDs: EOS: 0002560453594f53ba3e3f6d3b1e296a steam: 76561199557617668 | Contoller ID: BP_PlayerController_C_2147443815) caused by nullptr'

// nullptr death with no attacker (bled out) -- must still be dropped
const DIED_NULLPTR_INVALID =
	'[2026.07.02-12.19.51:267][953]LogSquadTrace: [DedicatedServer]Die(): Player:Lt.  mech1312 KillingDamage=100.000000 from nullptr (Online IDs: INVALID | Contoller ID: None) caused by nullptr'

const ADMIN_FORCED_TEAM_CHANGE =
	'[2026.07.05-02.11.35:542][495]LogSquad: ADMIN COMMAND: Forced team change for player 0. [Online IDs= EOS: 000249a430574933aefd9bbc9a8f2f37 steam: 76561198052229202]  grey275 from RCON'
const ADMIN_DISBANDED_SQUAD =
	'[2026.07.05-02.16.44:450][194]LogSquad: ADMIN COMMAND: Remote admin disbanded squad 1 on team 1, named "Squad 1" from RCON'
const ADMIN_REMOVED_FROM_SQUAD = '[2026.07.05-02.18.39:536][533]LogSquad: ADMIN COMMAND: Player  grey275 was removed from squad from RCON'

// --- Tests ---

describe('LogEvents.parse', () => {
	describe('PLAYER_DISCONNECTED', () => {
		it('parses a RemoveClientConnection disconnect', async () => {
			const events = await collect([PLAYER_DISCONNECTED, NEXT_TICK_EVENT].join('\n'))
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				type: 'PLAYER_DISCONNECTED',
				ip: '203.0.113.22',
				playerIds: expect.objectContaining({
					eos: '00026fd6fefb44a3a86b91925c95a40f',
					playerController: 'BP_PlayerController_C_2147247660',
				}),
			})
		})

		it('does not treat a beacon-queue (BeaconNetDriver) connection close as a disconnect', async () => {
			const errors: Error[] = []
			const events = await collect([BEACON_DISCONNECT, NEXT_TICK_EVENT].join('\n'), errors)
			expect(events.filter(e => e.type === 'PLAYER_DISCONNECTED')).toHaveLength(0)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({ type: 'UNKNOWN' })
			expect(errors).toHaveLength(0)
		})
	})

	describe('admin broadcast', () => {
		it('parses a single-line broadcast', async () => {
			const events = await collect([ADMIN_BROADCAST_SINGLE, NEXT_TICK_EVENT].join('\n'))
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({ type: 'ADMIN_BROADCAST', message: 'Hello world', source: { type: 'rcon' } })
		})

		it('parses a multiline broadcast where the continuation line matches a preamble pattern', async () => {
			const events = await collect([ADMIN_BROADCAST_MULTILINE, NEXT_TICK_EVENT].join('\n'))
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				type: 'ADMIN_BROADCAST',
				message: 'Hello world\nFactions: RGF+CombinedArms AFU+CombinedArms',
				source: {
					type: 'rcon',
				},
			})
		})
	})

	describe('PLAYER_WOUNDED', () => {
		it('parses wound with steam+EOS IDs and generic controller name', async () => {
			const events = await collect([PLAYER_WOUNDED, NEXT_TICK_EVENT].join('\n'))
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				type: 'PLAYER_WOUNDED',
				damage: 0,
				weapon: 'BP_Soldier_USMC_Rifleman1_Woodland',
				attackerIds: expect.objectContaining({
					steam: '76561198397430155',
					eos: '00029ce874284d2ba0199af5dd36a199',
					playerController: 'BP_PlayerController_C_2146093177',
				}),
				victimIds: expect.objectContaining({ username: 'RaT I Gangry' }),
			})
		})

		it('parses a wound whose weapon is a deployable without a _C suffix, keeping the token verbatim', async () => {
			const events = await collect([WOUND_FENCE, NEXT_TICK_EVENT].join('\n'))
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({ type: 'PLAYER_WOUNDED', weapon: 'Fence58_229' })
		})
	})

	describe('PLAYER_DIED', () => {
		it('parses a death whose killing weapon is nullptr but the attacker is known, with weapon null', async () => {
			const events = await collect([DIED_NULLPTR_WEAPON, NEXT_TICK_EVENT].join('\n'))
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				type: 'PLAYER_DIED',
				weapon: null,
				damage: 100,
				attackerIds: expect.objectContaining({
					eos: '0002560453594f53ba3e3f6d3b1e296a',
					playerController: 'BP_PlayerController_C_2147443815',
				}),
				victimIds: expect.objectContaining({ username: 'WildChildCao' }),
			})
		})

		it('drops a nullptr death when the attacker IDs are INVALID (bled out / no attacker)', async () => {
			const events = await collect([DIED_NULLPTR_INVALID, NEXT_TICK_EVENT].join('\n'))
			expect(events.filter(e => e.type === 'PLAYER_DIED')).toHaveLength(0)
		})
	})

	describe('admin squad/team commands', () => {
		it('parses a forced team change with target online ids and RCON source', async () => {
			const events = await collect([ADMIN_FORCED_TEAM_CHANGE, NEXT_TICK_EVENT].join('\n'))
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				type: 'ADMIN_FORCED_TEAM_CHANGE',
				playerIds: expect.objectContaining({
					eos: '000249a430574933aefd9bbc9a8f2f37',
					steam: '76561198052229202',
					username: 'grey275',
				}),
				source: { type: 'rcon' },
			})
		})

		it('parses a squad disband with squad/team ids and name', async () => {
			const events = await collect([ADMIN_DISBANDED_SQUAD, NEXT_TICK_EVENT].join('\n'))
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				type: 'ADMIN_DISBANDED_SQUAD',
				squadId: 1,
				teamId: 1,
				squadName: 'Squad 1',
				source: { type: 'rcon' },
			})
		})

		it('parses a remove-from-squad by username (no online ids in the log)', async () => {
			const events = await collect([ADMIN_REMOVED_FROM_SQUAD, NEXT_TICK_EVENT].join('\n'))
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				type: 'ADMIN_REMOVED_FROM_SQUAD',
				playerIds: expect.objectContaining({ username: 'grey275' }),
				source: { type: 'rcon' },
			})
		})
	})

	describe('non-chain events', () => {
		it('yields a non-chain event once the next chain starts', async () => {
			const events = await collect([NEW_GAME, NEXT_TICK_EVENT].join('\n'))
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({ type: 'NEW_GAME' })
		})

		it('yields multiple non-chain events in order', async () => {
			const events = await collect([NEW_GAME, NEW_GAME, NEXT_TICK_EVENT].join('\n'))
			expect(events).toHaveLength(2)
			expect(events[0]).toMatchObject({ type: 'NEW_GAME' })
			expect(events[1]).toMatchObject({ type: 'NEW_GAME' })
		})

		it('yields an UNKNOWN event for unrecognized log lines', async () => {
			const errors: Error[] = []
			const events = await collect(
				['[2025.11.19-18.18.26:000][  0]LogUnknown: something unrecognized', NEXT_TICK_EVENT].join('\n'),
				errors,
			)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({ type: 'UNKNOWN' })
			expect(errors).toHaveLength(0)
		})
	})

	describe('PLAYER_CONNECTED_CHAIN', () => {
		it('groups all four events into a single chain event', async () => {
			const events = await collect([JOIN_CHAIN, NEXT_TICK_EVENT].join('\n'))
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				type: 'PLAYER_CONNECTED_CHAIN',
				events: {
					PLAYER_CONNECTED: expect.objectContaining({ type: 'PLAYER_CONNECTED' }),
					PLAYER_JOIN_SUCCEEDED: expect.objectContaining({ type: 'PLAYER_JOIN_SUCCEEDED' }),
					PLAYER_ADDED_TO_TEAM: expect.objectContaining({ type: 'PLAYER_ADDED_TO_TEAM', teamId: 1 }),
				},
			})
		})

		it('handles two sequential join chains with different chainIDs', async () => {
			const events = await collect([JOIN_CHAIN, JOIN_CHAIN_NEW, NEXT_TICK_EVENT].join('\n'))
			expect(events).toHaveLength(2)
			expect(events[0]).toMatchObject({ type: 'PLAYER_CONNECTED_CHAIN' })
			expect(events[1]).toMatchObject({ type: 'PLAYER_CONNECTED_CHAIN' })
		})

		it('silently ignores unrecognized events with the same chainID mid-chain', async () => {
			const errors: Error[] = []
			// An unrecognized log line sharing chainID 549 appears between chain events — should be silently dropped
			const unknownSameChain = '[2025.11.19-18.18.26:150][549]LogSomething: Some unrecognized line'
			const events = await collect(
				[PLAYER_CONNECTED, PLAYER_JOIN_SUCCEEDED, unknownSameChain, PLAYER_ADDED_TO_TEAM, PLAYER_RESTARTED, NEXT_TICK_EVENT].join('\n'),
				errors,
			)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({ type: 'PLAYER_CONNECTED_CHAIN' })
			expect(errors).toHaveLength(0)
		})

		it('pushes error for incomplete chain when flushed by next chain', async () => {
			const errors: Error[] = []
			const events = await collect(
				[PLAYER_CONNECTED, PLAYER_ADDED_TO_TEAM, NEXT_TICK_EVENT].join('\n'),
				errors,
			)
			expect(events).toHaveLength(0)
			expect(errors).toHaveLength(1)
			expect(errors[0].message).toMatch(/PLAYER_JOIN_SUCCEEDED/)
		})

		it('pushes duplicate errors when chain-start event is repeated with the same chainID', async () => {
			const errors: Error[] = []
			const events = await collect(
				[
					PLAYER_CONNECTED,
					PLAYER_JOIN_SUCCEEDED,
					PLAYER_CONNECTED,
					PLAYER_JOIN_SUCCEEDED,
					PLAYER_ADDED_TO_TEAM,
					PLAYER_RESTARTED,
					NEXT_TICK_EVENT,
				].join(
					'\n',
				),
				errors,
			)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({ type: 'PLAYER_CONNECTED_CHAIN' })
			expect(errors.length).toBeGreaterThan(0)
			expect(errors[0].message).toMatch(/duplicate/i)
		})

		it('parses new format: steam ID, generic controller, PLAYER_RESTARTED before PLAYER_JOIN_SUCCEEDED, no PLAYER_ADDED_TO_TEAM', async () => {
			const events = await collect([JOIN_CHAIN_NEW, NEXT_TICK_EVENT].join('\n'))
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
					PLAYER_JOIN_SUCCEEDED: expect.objectContaining({ player: expect.objectContaining({ usernameNoTag: 'grey275' }) }),
				},
			})
		})

		it('yields a non-initiator chain event as a standalone event when no chain is in progress', async () => {
			const errors: Error[] = []
			const events = await collect([PLAYER_ADDED_TO_TEAM, NEXT_TICK_EVENT].join('\n'), errors)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({ type: 'PLAYER_ADDED_TO_TEAM' })
			expect(errors).toHaveLength(0)
		})

		it('pushes error for abandoned chain when a different chain starts with a new chainID', async () => {
			const errors: Error[] = []
			// ROUND_ENDED_MAIN (chainID 979) starts a different chain while join chain (chainID 549) is in progress
			const events = await collect(
				[PLAYER_CONNECTED, ROUND_ENDED_MAIN, ROUND_DECIDED, ROUND_DECIDED_LOSER, NEXT_TICK_EVENT].join('\n'),
				errors,
			)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({ type: 'ROUND_ENDED_CHAIN' })
			expect(errors).toHaveLength(1)
			expect(errors[0].message).toMatch(/PLAYER_JOIN_SUCCEEDED/)
		})
	})

	describe('ROUND_ENDED_CHAIN', () => {
		it('groups three events into a single chain event', async () => {
			const events = await collect([ROUND_CHAIN, NEXT_TICK_EVENT].join('\n'))
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				type: 'ROUND_ENDED_CHAIN',
				events: {
					ROUND_ENDED: expect.objectContaining({ type: 'ROUND_ENDED' }),
					ROUND_DECIDED_WINNER: expect.objectContaining({ type: 'ROUND_DECIDED_WINNER', team: 1, tickets: 150 }),
					ROUND_DECIDED_LOSER: expect.objectContaining({ type: 'ROUND_DECIDED_LOSER', team: 2, tickets: 0 }),
				},
			})
		})

		it('includes ADMIN_ENDED_MATCH with rcon source when match is ended via RCON', async () => {
			const errors: Error[] = []
			const events = await collect(ROUND_ADMIN_CHAIN, errors)
			expect(errors).toHaveLength(0)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				type: 'ROUND_ENDED_CHAIN',
				events: {
					ROUND_ENDED: expect.objectContaining({ type: 'ROUND_ENDED' }),
					ADMIN_ENDED_MATCH: expect.objectContaining({ source: { type: 'rcon' } }),
				},
			})
			expect(events[0]).not.toHaveProperty('events.ROUND_DECIDED_WINNER')
		})

		it('includes ADMIN_ENDED_MATCH with player source when match is ended via in-game admin', async () => {
			const errors: Error[] = []
			const events = await collect(ROUND_ADMIN_PLAYER_CHAIN, errors)
			expect(errors).toHaveLength(0)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				type: 'ROUND_ENDED_CHAIN',
				events: {
					ADMIN_ENDED_MATCH: expect.objectContaining({
						source: {
							type: 'player',
							playerIds: expect.objectContaining({
								eos: '000249a430574933aefd9bbc9a8f2f37',
								steam: '76561198052229202',
							}),
						},
					}),
				},
			})
		})

		it('includes LAYER_CHANGED with player source when an admin runs AdminChangeLayer', async () => {
			const errors: Error[] = []
			const events = await collect([ADMIN_LAYER_CHANGED_PLAYER_CHAIN, NEXT_TICK_EVENT].join('\n'), errors)
			expect(errors).toHaveLength(0)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				type: 'ROUND_ENDED_CHAIN',
				events: {
					LAYER_CHANGED: expect.objectContaining({
						layer: 'AlBasrah_AAS_v1 RGF+CombinedArms MEI+CombinedArms',
						source: {
							type: 'player',
							playerIds: expect.objectContaining({
								eos: '000249a430574933aefd9bbc9a8f2f37',
								steam: '76561198052229202',
							}),
						},
					}),
				},
			})
			expect(events[0]).not.toHaveProperty('events.ADMIN_ENDED_MATCH')
		})

		it('handles a draw (team -1)', async () => {
			const errors: Error[] = []
			const events = await collect([ROUND_DRAW_CHAIN, NEXT_TICK_EVENT].join('\n'), errors)
			expect(errors).toHaveLength(0)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				type: 'ROUND_ENDED_CHAIN',
				events: {
					ROUND_ENDED: expect.objectContaining({ type: 'ROUND_ENDED' }),
					ROUND_DECIDED_WINNER: expect.objectContaining({ type: 'ROUND_DECIDED_WINNER', team: -1, tickets: -1 }),
					ROUND_DECIDED_LOSER: expect.objectContaining({ type: 'ROUND_DECIDED_LOSER', team: -1, tickets: -1 }),
				},
			})
		})
	})

	describe('continuation lines', () => {
		it('includes non-log continuation lines in the raw field of the parsed event', async () => {
			const logWithContinuation = NEW_GAME + '\nsome unexpected continuation text'
			const events = await collect([logWithContinuation, NEXT_TICK_EVENT].join('\n'))
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				type: 'NEW_GAME',
				raw: expect.stringContaining('some unexpected continuation text'),
			})
		})

		it('includes multiple continuation lines joined with newlines', async () => {
			const logWithContinuations = NEW_GAME + '\nfirst continuation\nsecond continuation'
			const events = await collect([logWithContinuations, NEXT_TICK_EVENT].join('\n'))
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				type: 'NEW_GAME',
				raw: expect.stringContaining('first continuation\nsecond continuation'),
			})
		})

		it('does not bleed continuation lines into the next event', async () => {
			const logWithContinuation = NEW_GAME + '\nsome continuation'
			const events = await collect([logWithContinuation, NEW_GAME, NEXT_TICK_EVENT].join('\n'))
			expect(events).toHaveLength(2)
			expect(events[0]).toMatchObject({ type: 'NEW_GAME', raw: expect.stringContaining('some continuation') })
			expect((events[1] as any).raw).not.toContain('some continuation')
		})
	})

	describe('mixed events', () => {
		it('yields non-chain events before and after a chain', async () => {
			const events = await collect([NEW_GAME, JOIN_CHAIN, NEW_GAME, NEXT_TICK_EVENT].join('\n'))
			expect(events).toHaveLength(3)
			expect(events[0]).toMatchObject({ type: 'NEW_GAME' })
			expect(events[1]).toMatchObject({ type: 'PLAYER_CONNECTED_CHAIN' })
			expect(events[2]).toMatchObject({ type: 'NEW_GAME' })
		})

		it('yields two different chain types sequentially', async () => {
			const events = await collect([JOIN_CHAIN, ROUND_CHAIN, NEXT_TICK_EVENT].join('\n'))
			expect(events).toHaveLength(2)
			expect(events[0]).toMatchObject({ type: 'PLAYER_CONNECTED_CHAIN' })
			expect(events[1]).toMatchObject({ type: 'ROUND_ENDED_CHAIN' })
		})
	})
})

describe('RconEvents', () => {
	describe('PLAYER_WARNED', () => {
		it('parses a single-line warn message', () => {
			const [event, err] = matchLog(
				'Remote admin has warned player TestUser. Message was "you did a bad thing"',
				[SM.RconEvents.PlayerWarnedMatcher],
			)
			expect(err).toBeNull()
			expect(event).toMatchObject({
				type: 'PLAYER_WARNED',
				reason: 'you did a bad thing',
				playerIds: expect.objectContaining({ username: 'TestUser' }),
			})
		})

		it('parses a multiline warn message', () => {
			const [event, err] = matchLog(
				'Remote admin has warned player TestUser. Message was "Line one\nLine two\nLine three"',
				[SM.RconEvents.PlayerWarnedMatcher],
			)
			expect(err).toBeNull()
			expect(event).toMatchObject({
				type: 'PLAYER_WARNED',
				reason: 'Line one\nLine two\nLine three',
				playerIds: expect.objectContaining({ username: 'TestUser' }),
			})
		})
	})
})

describe('PlayerIds.findByUsernameLoose', () => {
	const player = (eos: string, username: string) => ({ ids: { eos, username } })

	it('matches when the roster name contains the target (tag/whitespace tolerant)', () => {
		const players = [player('a', '『LiQ』  HoneyBooBoo rides again'), player('b', 'Hopeless')]
		expect(SM.PlayerIds.findByUsernameLoose(players, p => p.ids, 'HoneyBooBoo rides again')).toBe(players[0])
	})

	it('matches in reverse when the log name carries a tag the roster name lacks', () => {
		const players = [player('a', 'HoneyBooBoo rides again'), player('b', 'Hopeless')]
		expect(SM.PlayerIds.findByUsernameLoose(players, p => p.ids, '[LiQ] HoneyBooBoo rides again')).toBe(players[0])
	})

	it('returns undefined when the match is ambiguous', () => {
		const players = [player('a', 'AAA alpha'), player('b', 'beta AAA')]
		expect(SM.PlayerIds.findByUsernameLoose(players, p => p.ids, 'AAA')).toBeUndefined()
	})
})

describe('toRecentPlayer', () => {
	// A player persisted before adminGroups existed reaches the reducer with the field simply absent (the schema
	// leaves it optional). Spreading that threw "adminGroups is not iterable" and took the whole chat feed down on
	// any RESET replaying such an event.
	it('accepts a player persisted before adminGroups existed', () => {
		const legacy = {
			ids: { eos: 'e1', playerController: 'ctrl', username: 'legacy' },
			isAdmin: true,
			role: 'Rifleman_01',
		} as unknown as SM.RecentPlayer

		const recent = SM.toRecentPlayer(legacy)
		expect(recent.adminGroups).toEqual([])
		expect(recent.isAdmin).toBe(true)
	})

	it('copies admin groups rather than aliasing them', () => {
		const groups = ['Admins']
		const recent = SM.toRecentPlayer({ ids: { eos: 'e1', playerController: 'c', username: 'u' }, isAdmin: true, adminGroups: groups })
		expect(recent.adminGroups).toEqual(['Admins'])
		groups.push('Whitelist')
		expect(recent.adminGroups).toEqual(['Admins'])
	})
})
