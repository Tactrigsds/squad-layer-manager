import { type AppFixture, createAppFixture, LOG_INGEST_SETTLE_MS } from './app-fixture'
import { LAYERS, queue } from './arrange'
import { latestMatch as latestMatchOf } from './inspect'

// The map roll is the trickiest window in the event pipeline: the app enters `syncState: 'rolling'` on the
// TransitionMap log, commits the destination NEW_GAME once it arrives, then waits for the first roster poll
// timestamped after that to produce the boundary-completing RESET (see pending-events.models.ts). Anything
// that happens to a player in between -- connecting, disconnecting, changing team on their own -- is folded
// into that one wholesale roster snapshot rather than reported as an individual event, by design.
//
// On the real game server, players are also blocked from self-serve team changes for a few seconds after the
// destination "Bringing World" line, so an organic team change can only be genuine either shortly before a
// roll starts or once the new match has been running a while -- never in the instant right after. The
// scenarios built on this respect that: they never simulate a self-swap landing in the very first post-roll
// poll, since that can't happen on a real server (the automatic side-swap every player gets as part of the
// roll itself is a different thing, and is asserted on separately).
//
// The scenarios live in two files -- server-rolling.test.ts for what the roster does across the window, and
// server-rolling-attribution.test.ts for which match an event is attributed to -- because every step of one
// waits on a roster poll, and one file's worth of them was long enough to set the whole suite's wall time.

// in-game admin for the scenarios that need one to issue a command
export const ROLL_ADMIN_STEAM_ID = '76561198000000009'

export type RollingFixture = AppFixture & {
	// Rolls to whatever the app has already set as the emulator's next layer (via its own AdminSetNextLayer,
	// driven by its queue). Deliberately doesn't override the layer directly: doing so fights the app's own
	// idea of what the next layer should be -- it keeps re-asserting its queue head over RCON every poll to
	// correct the "external" change, which is realistic server behavior but not what these tests are after.
	roll: () => void
	// Runs `fn` with RCON genuinely down, so no ListPlayers poll can complete until it comes back -- whatever
	// `fn` does (roll, connect, disconnect) is guaranteed to still be mid-roll from the app's point of view when
	// it resolves. The settle delay after goOffline mirrors cycleRcon's default downMs: without it the app may
	// not have noticed the drop yet, which is what made an earlier version of this flaky.
	withRconOffline: <T>(fn: () => T) => Promise<T>
	latestMatch: () => { id: number; layerId: string }
	// match creation is purely log-driven (onNewGameDuringRoll), so it can lag slightly behind
	// waitForRosterSync's RCON-based notion of "settled" -- poll rather than read once
	waitForNewMatch: (oldMatchId: number) => Promise<{ id: number; layerId: string }>
	// a RESET's roster is recorded via playerEventAssociations (assocType 'game-participant'), so "was this
	// player in the roster this RESET carried" is just a join, no need to touch the superjson-encoded payload
	inResetRoster: (matchId: number, eos: string) => boolean
	countEventsFor: (type: string, eos: string, matchId?: number) => number
	// appEventId is only populated when the event's source links back to an app event (an admin/system action);
	// an organic change inferred purely from team polling never carries one. See buildEventRows in
	// squad-server.server.ts.
	latestTeamChangeIsOrganic: (matchId: number, eos: string) => boolean | undefined
}

export async function createRollingFixture(): Promise<RollingFixture> {
	const app = await createAppFixture({
		layerQueue: queue(LAYERS.gorodokRaas, LAYERS.sumariSeed),
		admins: [ROLL_ADMIN_STEAM_ID],
		adminSteamIds: [ROLL_ADMIN_STEAM_ID],
	})

	const latestMatch = () => latestMatchOf(app)

	return {
		...app,
		latestMatch,
		roll: () => {
			app.emu.world.endMatch()
			app.emu.world.startNewGame()
		},
		withRconOffline: async (fn) => {
			const port = app.emu.rconPort
			await app.emu.rcon.goOffline()
			await new Promise((resolve) => setTimeout(resolve, 500))
			try {
				return fn()
			} finally {
				// Hold the window open until the app has read what `fn` logged. Bringing RCON back sooner lets the poll
				// that completes the roll beat those lines into the pipeline, which is a different scenario: the app
				// would then see the connect/disconnect against the settled new match rather than mid-roll.
				await new Promise((resolve) => setTimeout(resolve, LOG_INGEST_SETTLE_MS))
				await app.emu.rcon.goOnline(port)
			}
		},
		waitForNewMatch: (oldMatchId) =>
			app.waitFor(
				() => {
					const match = latestMatch()
					return match.id > oldMatchId ? match : undefined
				},
				{ label: 'the roll producing a new match history row' },
			),
		inResetRoster: (matchId, eos) => {
			const db = app.readDb()
			try {
				const row = db
					.prepare(
						`SELECT se.id FROM serverEvents se
						 JOIN playerEventAssociations pea ON pea.serverEventId = se.id
						 WHERE se.type = 'RESET' AND se.matchId = ? AND pea.playerId = ?`,
					)
					.get(matchId, eos)
				return !!row
			} finally {
				db.close()
			}
		},
		countEventsFor: (type, eos, matchId) => {
			const db = app.readDb()
			try {
				const row = db
					.prepare(
						`SELECT count(*) as n FROM serverEvents se
						 JOIN playerEventAssociations pea ON pea.serverEventId = se.id
						 WHERE se.type = ? AND pea.playerId = ?${matchId !== undefined ? ' AND se.matchId = ?' : ''}`,
					)
					.get(...(matchId !== undefined ? [type, eos, matchId] : [type, eos])) as { n: number }
				return row.n
			} finally {
				db.close()
			}
		},
		latestTeamChangeIsOrganic: (matchId, eos) => {
			const db = app.readDb()
			try {
				const row = db
					.prepare(
						`SELECT se.appEventId as appEventId FROM serverEvents se
						 JOIN playerEventAssociations pea ON pea.serverEventId = se.id
						 WHERE se.type = 'PLAYER_CHANGED_TEAM' AND se.matchId = ? AND pea.playerId = ?
						 ORDER BY se.id DESC LIMIT 1`,
					)
					.get(matchId, eos) as { appEventId: string | null } | undefined
				return row === undefined ? undefined : row.appEventId === null
			} finally {
				db.close()
			}
		},
	}
}
