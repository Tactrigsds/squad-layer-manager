import * as FB from '@/models/filter-builders'

import type { AppFixtureOptions, TestUser } from '../harness/app-fixture'
import { filter, LAYERS, queue, role, selectableFilter } from '../harness/arrange'

// The named shapes of load. A scenario is the whole recipe: what the app is seeded with, how many of each
// actor, how hard each of them pushes, and for how long.
//
// They differ in what they are trying to catch. `busy-server` is the steady state a real install lives in and
// is what a cpu profile should be read from. `soak` runs the same load thin and long, because a leak is
// invisible in five minutes. `spike` is subscription fan-out alone, which is the one axis an install can cross
// without warning -- everybody opens the dashboard when the server is full.

export type Scenario = {
	name: string
	description: string
	// in-game players held on the emulated server
	players: number
	// real dashboards
	browsers: number
	// websocket clients holding a dashboard's subscriptions without rendering them
	synthetic: number
	durationMs: number
	// load runs during this, but the profile does not start until it is over, so boot and the first roster
	// polls do not dominate what the profile shows
	warmupMs: number
	// mean gap between in-game actions, across the whole server
	ingameActionIntervalMs: number
	// mean gap between map rolls; 0 never rolls
	rollIntervalMs: number
	syntheticPollIntervalMs: number
	browserJourneyIntervalMs: number
	// full heap snapshots, spread evenly across the run. Always at least the two boundaries.
	heapSnapshots: number
}

export const SCENARIOS: Record<string, Scenario> = {
	smoke: {
		name: 'smoke',
		description: 'the harness itself, in a minute: a few of everything',
		players: 12,
		browsers: 1,
		synthetic: 3,
		durationMs: 60_000,
		warmupMs: 15_000,
		ingameActionIntervalMs: 500,
		rollIntervalMs: 30_000,
		syntheticPollIntervalMs: 5_000,
		browserJourneyIntervalMs: 3_000,
		heapSnapshots: 2,
	},
	'busy-server': {
		name: 'busy-server',
		description: 'a full server on a busy evening, with a normal number of admins watching',
		players: 80,
		browsers: 3,
		synthetic: 25,
		durationMs: 5 * 60_000,
		warmupMs: 45_000,
		// a full server produces a log line every few hundred ms between chat, killfeed and squad churn
		ingameActionIntervalMs: 300,
		rollIntervalMs: 90_000,
		syntheticPollIntervalMs: 10_000,
		browserJourneyIntervalMs: 4_000,
		heapSnapshots: 2,
	},
	spike: {
		name: 'spike',
		description: 'everyone opens the dashboard at once: subscription fan-out with a full server underneath',
		players: 80,
		browsers: 2,
		synthetic: 120,
		durationMs: 3 * 60_000,
		warmupMs: 30_000,
		ingameActionIntervalMs: 300,
		rollIntervalMs: 60_000,
		syntheticPollIntervalMs: 8_000,
		browserJourneyIntervalMs: 5_000,
		heapSnapshots: 2,
	},
	soak: {
		name: 'soak',
		description: 'the same load run thin for half an hour, to see what is retained rather than what is slow',
		players: 60,
		browsers: 1,
		synthetic: 10,
		durationMs: 30 * 60_000,
		warmupMs: 60_000,
		ingameActionIntervalMs: 800,
		rollIntervalMs: 120_000,
		syntheticPollIntervalMs: 20_000,
		browserJourneyIntervalMs: 15_000,
		heapSnapshots: 4,
	},
}

// The seeded admin's in-game identity. Its steam id is derived from the name (see steamIdForName), which is
// what lets the fixture put it in Admins.cfg before the app boots -- the admin list is cached for an hour
// afterwards, so a later rewrite would never be read.
export const ADMIN_PLAYER = 'LoadAdmin'

const POOL_FILTER = 'load-pool'
const INDICATOR_FILTER = 'load-indicator'

// Viewers, one per client. Distinct users rather than one repeated: user presence, the editing session and
// every permission check are keyed by user, and a hundred connections from one account would collapse work
// the server really does per person.
export function viewerUsers(count: number): TestUser[] {
	// bigint arithmetic, not number: these ids are past Number.MAX_SAFE_INTEGER, so adding the index as a
	// number silently gives several viewers the same id
	return Array.from({ length: count }, (_, index) => ({
		discordId: 900000000000001000n + BigInt(index),
		username: `load-viewer-${index}`,
	}))
}

// What the app is seeded with. The pool config is the part that matters: with a pool filter and repeat rules
// set, every roll makes the app generate the next queue item through the layer engine, which is the most
// expensive thing it does on its own behalf.
export function fixtureOptions(scenario: Scenario, viewers: TestUser[], adminSteamId: string): AppFixtureOptions {
	return {
		layerQueue: queue(LAYERS.gorodokRaas, LAYERS.harjuRaas, LAYERS.narvaRaas),
		admins: [adminSteamId],
		adminSteamIds: [adminSteamId],
		users: viewers,
		filters: [
			filter(POOL_FILTER, 'Load Pool', FB.and([FB.eq('Gamemode', 'RAAS'), FB.eq('Collection', 'OWI')])),
			filter(INDICATOR_FILTER, 'Load Indicator', FB.and([FB.inValues('Map', ['Gorodok', 'Narva', 'Harju', 'Skorpo'])])),
		],
		serverSettings: (settings) => {
			const pool = settings.queue.mainPool
			pool.poolFilter = { filterId: POOL_FILTER, mode: 'include' }
			selectableFilter(pool, INDICATOR_FILTER)
			pool.repeatRules = [
				{ label: 'Map', field: 'Map', within: 4, autogen: true },
				{ label: 'Layer', field: 'Layer', within: 8, autogen: true },
			]
		},
		globalSettings: (settings) => {
			// site:authorized is what lets a session exist at all; without it every viewer's socket is refused and
			// the fleet measures nothing. queue:write puts the browsers on the same footing as a real admin.
			settings.rbac.roles['load-viewer'] = role(['site:authorized', 'queue:write'], { users: viewers })
		},
		emulator: {
			// a real server spends 30s in WaitingPostMatch; the fixture turns that down to 50ms for test speed,
			// which would make every roll in a load run an instant transition rather than the window the app
			// actually has to hold state through
			postMatchDelayMs: 10_000,
		},
	}
}
