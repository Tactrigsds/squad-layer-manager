import * as Schema from '$root/drizzle/schema.ts'
import * as FB from '@/models/filter-builders'
import type * as F from '@/models/filter.models'
import type * as SETTINGS from '@/models/settings.models'
import type * as C from '@/server/context.ts'
import { initModule } from '@/server/logger'

// What a database with nothing in it starts life as. A fresh install boots straight into a working pool rather
// than an empty one: these filters are inserted before anything reads the filters table, and the pool config
// naming them is applied to the sandbox server the same boot creates (see sandbox.server seedServerIfEnabled).
//
// It only ever runs against an empty database. Deleting a seeded filter is meant to stick, so nothing here is
// reconciled on later boots.

const module = initModule('seed')
let log!: ReturnType<typeof module.getLogger>

// The filters ship without an administrator to own them, so they are owned by SLM itself. A discord snowflake
// is far larger than this, so it can never collide with a real user.
const SEED_USER: typeof Schema.users.$inferInsert = { discordId: 1n, username: 'SLM' }

type SeededFilter = Omit<F.FilterEntity, 'owner'>

// Derived from the pool a real server runs. Ids are stable: the seeded pool configuration names them.
const SEEDED_FILTERS: SeededFilter[] = [
	{
		id: 'main-pool',
		name: 'Main Pool',
		description: 'The layers this server plays by default: the competitive pool, minus broken layers and same-nation matchups.',
		filter: FB.and([
			FB.isTrue('Z_Pool'),
			FB.neq('Map', 'Sanxian'),
			FB.nor([
				FB.and([FB.inValues('Faction_1', ['USA', 'USMC']), FB.inValues('Faction_2', ['USA', 'USMC'])]),
				FB.and([FB.inValues('Faction_1', ['PLANMC', 'PLAAGF', 'PLA']), FB.inValues('Faction_2', ['PLANMC', 'PLAAGF', 'PLA'])]),
				FB.and([FB.inValues('Faction_1', ['VDV', 'RGF']), FB.inValues('Faction_2', ['VDV', 'RGF'])]),
			]),
		]),
		emoji: '✅',
		alertMessage: 'In the main pool',
		invertedEmoji: '⛔',
		invertedAlertMessage: 'Not in the main pool',
	},
	{
		id: 'seeding',
		name: 'Seeding',
		description: 'Small layers to run while the server fills up.',
		filter: FB.and([
			FB.eq('Gamemode', 'Seed'),
			FB.inValues('Layer', [
				'Manicouagan_Seed_v2_CL',
				'Sumari_Seed_v1',
				'AlBasrah_Seed_v1',
				'AlBasrah_Seed_v2',
				'Fallujah_Seed_v1',
				'Harju_Seed_v1',
				'BlackCoast_Seed_v1',
			]),
			FB.nor([FB.inValues('Faction_1', ['PLANMC', 'PLAAGF']), FB.inValues('Faction_2', ['PLANMC', 'PLAAGF'])]),
		]),
		emoji: '🌱',
		alertMessage: 'Seeding layer',
		invertedEmoji: '🌳',
		invertedAlertMessage: 'Not a seeding layer',
	},
	{
		id: 'no-mech-on-hilly',
		name: 'No Mech on Hilly Maps',
		description: 'Keeps mechanized and armored matchups off the maps their vehicles cannot get around.',
		filter: FB.nand([
			FB.inValues('Map', ['Manicouagan', 'Skorpo', 'Lashkar']),
			FB.or([FB.inValues('Unit_1', ['Mechanized', 'Armored']), FB.inValues('Unit_2', ['Mechanized', 'Armored'])]),
		]),
		emoji: '⛰️',
		alertMessage: 'No heavy armor on a hilly map',
		invertedEmoji: '🚜',
		invertedAlertMessage: 'Heavy armor on a hilly map',
	},
]

// The pool the seeded filters are there to define. Applied to the settings of the server a fresh install
// creates for itself, so it opens on a configured pool instead of an unconstrained one.
export function applyInitialPoolConfig(settings: SETTINGS.ServerSettings): SETTINGS.ServerSettings {
	return {
		...settings,
		queue: {
			...settings.queue,
			mainPool: {
				...settings.queue.mainPool,
				poolFilter: { filterId: 'main-pool', mode: 'include' },
				indicateMatches: ['seeding'],
				defaultSelectable: [{ filterId: 'no-mech-on-hilly', applyAs: 'disabled' }],
			},
		},
	}
}

// Runs before anything reads the filters table, and only against a database that has never been configured --
// which is what an empty globalSettings table means (settings.server writes that row on the same boot).
export async function setup(ctx: C.Db) {
	log = module.getLogger()
	const configured = await ctx.db().select({ id: Schema.globalSettings.id }).from(Schema.globalSettings).limit(1)
	if (configured.length > 0) return

	await ctx.db().insert(Schema.users).values(SEED_USER).onConflictDoNothing()
	await ctx
		.db()
		.insert(Schema.filters)
		.values(SEEDED_FILTERS.map((filter) => ({ ...filter, owner: SEED_USER.discordId })))
	log.info('Seeded %d filters for a fresh install', SEEDED_FILTERS.length)
}
