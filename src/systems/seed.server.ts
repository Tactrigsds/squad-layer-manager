import * as Schema from '$root/drizzle/schema.ts'
import * as DF from '@/models/demo-fleet.models'
import * as FB from '@/models/filter-builders'
import type * as F from '@/models/filter.models'
import * as PG from '@/models/player-groupings.models'
import * as SB from '@/models/sandbox.models'
import type * as SETTINGS from '@/models/settings.models'
import type * as C from '@/server/context.ts'
import * as Env from '@/server/env'
import { initModule } from '@/server/logger'

// What a database with nothing in it starts life as. A fresh install boots straight into a working pool rather
// than an empty one: these filters are inserted before anything reads the filters table, and the pool config
// naming them is applied to the sandbox server the same boot creates (see sandbox.server seedServerIfEnabled).
//
// It only ever runs against an empty database. Deleting a seeded filter is meant to stick, so nothing here is
// reconciled on later boots.

const module = initModule('seed')
let log!: ReturnType<typeof module.getLogger>

const envBuilder = Env.getEnvBuilder({ ...Env.groups.demo })
let ENV!: ReturnType<typeof envBuilder>

// The filters ship without an administrator to own them, so they are owned by SLM itself. A discord snowflake
// is far larger than this, so it can never collide with a real user.
const SEED_USER: typeof Schema.users.$inferInsert = { discordId: 1n }
const SEED_ACCOUNT: typeof Schema.discordAccounts.$inferInsert = { discordId: SEED_USER.discordId, username: 'SLM', updatedAt: new Date(0) }

type SeededFilter = Omit<F.FilterEntity, 'owner'>

// Derived from the pool a real server runs. Ids are stable: the seeded pool configuration names them, and
// main-pool composes the other two rather than restating what they say.
const SEEDED_FILTERS: SeededFilter[] = [
	{
		id: 'main-pool',
		name: 'Main Pool',
		description:
			'The layers this server plays by default: the competitive pool, minus similar-faction matchups and heavy armor on hilly maps.',
		filter: FB.and([
			FB.includedIn('vanilla-collections'),
			FB.isTrue('Z_Pool'),
			FB.excludedFrom('similar-factions'),
			FB.includedIn('no-mech-on-hilly'),
		]),
		emoji: '✅',
		alertMessage: 'In the main pool',
		invertedEmoji: '⛔',
		invertedAlertMessage: 'Not in the main pool',
	},
	{
		id: 'vanilla-collections',
		name: 'Vanilla Collections',
		description: 'Layers an unmodded server can run: the OWI collection.',
		filter: FB.eq('Collection', 'OWI'),
		emoji: '🍦',
		alertMessage: 'Runs on vanilla Squad',
		invertedEmoji: '🧩',
		invertedAlertMessage: 'Needs a mod installed on the server',
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
	{
		id: 'similar-factions',
		name: 'Similar Factions',
		description: 'Factions are very similar for these layers.',
		filter: FB.or([
			FB.inValues(FB.teamCol('Faction', 'both'), ['PLA', 'PLAAGF', 'PLANMC']),
			FB.inValues(FB.teamCol('Faction', 'both'), ['VDV', 'RGF']),
		]),
		emoji: '🪞',
		alertMessage: 'Factions are very similar for this layer. Expect teamkills.',
		invertedEmoji: '⚔️',
		invertedAlertMessage: 'Factions are distinct for this layer.',
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
				indicateMatches: ['seeding', 'similar-factions'],
				defaultSelectable: [{ filterId: 'no-mech-on-hilly', applyAs: 'disabled' }],
			},
		},
	}
}

const DOCS_BASE = 'https://github.com/Tactrigsds/squad-layer-manager'

// Enough of a starting set that the reason picker is not empty and `/warn <player> tk` works out of the box. The
// text reaches the player verbatim, so it is addressed to them; keywords are what an admin types in chat, and are
// matched as a single token (never whitespace).
const SEEDED_ADMIN_ACTION_REASONS: SETTINGS.GlobalSettings['adminActionReasons'] = [
	{
		label: 'Teamkilling',
		keywords: ['tk', 'teamkill'],
		actionTexts: {
			warn: 'Do not team kill.',
			kill: 'Killed for team killing.',
			kick: 'Kicked for team killing.',
			timeout: 'Team killing. You can rejoin in {{duration}}.',
		},
	},
	{
		label: 'Abusive Behaviour',
		keywords: ['abuse', 'toxicity'],
		actionTexts: {
			warn: 'Keep it civil.',
			kick: 'Kicked for abusive behaviour.',
			timeout: 'Abusive behaviour. You can rejoin in {{duration}}.',
		},
	},
	{
		label: 'Wasting Assets',
		keywords: ['assetwaste'],
		actionTexts: {
			warn: 'Stop wasting assets.',
			kick: 'Kicked for wasting assets.',
		},
	},
	{
		label: 'Not Leading',
		keywords: ['notleading'],
		actionTexts: {
			warn: 'Lead your squad or hand it to someone who will.',
			'remove-from-squad': 'Removed from your squad, which needs a leader who will lead it.',
			'disband-squad': 'Squad disbanded: nobody was leading it.',
			'demote-commander': 'Demoted: the commander slot needs someone actively leading.',
		},
	},
	{
		label: 'Seeding Rules',
		keywords: ['seedrules'],
		actionTexts: {
			warn: 'Seeding rules are in effect. Fight for the middle flag only.',
			broadcast: 'Seeding rules are in effect: middle flag only, and stay out of main bases.',
		},
	},
]

// Applied to the default global settings on their way into a fresh database (see settings.server
// loadGlobalSettings). Anything here would otherwise have to be a schema prefault, which existing installs
// missing the field would pick up on their next boot; this only ever reaches a database with no settings row.
export function applyInitialGlobalSettings(defaults: SETTINGS.GlobalSettings): SETTINGS.GlobalSettings {
	const demoFleetRoles = ENV.DEMO_LOGIN_TOKEN_PUBKEY ? DF.initialRoles() : {}
	return {
		...defaults,
		rbac: { ...defaults.rbac, roles: { ...defaults.rbac.roles, ...demoFleetRoles } },
		adminActionReasons: SEEDED_ADMIN_ACTION_REASONS,
		// the sandbox this same boot creates seeds its admin list with exactly these groups, so the teams panel and
		// the stats breakdown have something to say about it before anyone configures anything
		playerGroupings: { [PG.SEEDED_GROUPING_ID]: PG.adminListGrouping(SB.SEEDED_ADMIN_GROUPS) },
		navLinks: [
			{ label: 'SLM on GitHub', url: DOCS_BASE },
			{ label: 'Installing SLM', url: `${DOCS_BASE}/blob/main/docs/installing.md` },
		],
	}
}

// Runs before anything reads the filters table, and only against a database that has never been configured --
// which is what an empty globalSettings table means (settings.server writes that row on the same boot).
export async function setup(ctx: C.Db) {
	log = module.getLogger()
	ENV = envBuilder()
	const configured = await ctx.db().select({ id: Schema.globalSettings.id }).from(Schema.globalSettings).limit(1)
	if (configured.length > 0) return

	await ctx.db().insert(Schema.discordAccounts).values(SEED_ACCOUNT).onConflictDoNothing()
	await ctx.db().insert(Schema.users).values(SEED_USER).onConflictDoNothing()
	await ctx
		.db()
		.insert(Schema.filters)
		.values(SEEDED_FILTERS.map((filter) => ({ ...filter, owner: SEED_USER.discordId })))
	log.info('Seeded %d filters for a fresh install', SEEDED_FILTERS.length)
}
