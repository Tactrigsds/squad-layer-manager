import * as z from 'zod'

import * as ZU from 'slm/lib/zod-utils'
import { definePlugin } from 'slm/plugin'
import { Fields } from 'slm/plugin/fields'

export const DEFAULT_CRITERIA = 'population >= 18 && currentTime.minutesOfDay >= 14 * 60 && currentTime.minutesOfDay <= 15 * 60 + 30'

export default definePlugin({
	id: 'seed-roller',
	name: 'Seed Roller',
	version: '0.1.0',
	apiVersion: '^0.3',
	description: 'Rolls a training layer onto a seeding layer once the server is busy enough, at the time of day seeding happens.',
	configSchema: z.object({
		criteria: z
			.string()
			.prefault(DEFAULT_CRITERIA)
			.describe(
				'A javascript expression. Variables: population, afkPopulation, activePopulation, and currentTime ' +
					'({ hour, minute, minutesOfDay, weekday }, 0 = Sunday), read in the timezone below.',
			),
		timezone: z.string().prefault('America/New_York').describe('IANA timezone the criteria read the clock in'),
		afkWindow: ZU.HumanTime.prefault('5m').describe('How long since a player last did anything before they count as AFK'),

		// prefaulted so a freshly installed plugin is idle and says what it needs, rather than failing
		// activation with a config error before an admin has had a chance to configure it
		seedPool: Fields.filterId().prefault('').describe('Pool the seeding layer is drawn from'),
		followUpPool: Fields.filterId().prefault('').describe('Pool the layer after the seeding layer is drawn from'),
		// empty means unconfigured, which the panel reports; anything else has to be a snowflake, since the
		// queue ops take it as a bigint
		editorUserId: z
			.string()
			.regex(/^\d*$/, 'a discord id is digits only')
			.prefault('')
			.describe('Discord id the queue edits are recorded against. Name the admin answerable for them.'),

		countdown: ZU.HumanTime.prefault('30s').describe('How long admins get to cancel after being warned'),
		adminWarning: z
			.string()
			.prefault('Rolling to seed ({{layer}}) in {{seconds}}s. Cancel on the SLM dashboard.')
			.describe('Warned to every in-game admin when the roll is armed. Variables: {{layer}}, {{seconds}}, {{population}}'),
		broadcast: z
			.string()
			.prefault('Rolling to seeding layer {{layer}}.')
			.describe('Broadcast to the server immediately before the roll. Same variables as the admin warning.'),

		discordChannel: Fields.discordChannelId().prefault('').describe('Where the roll is announced. Empty posts nothing.'),
		discordMessage: Fields.multilineText()
			.prefault('Rolling **{{server}}** to seed: **{{layer}}** ({{population}} players, {{activePopulation}} active).')
			.describe('The announcement. Variables: {{server}}, {{layer}}, {{seconds}}, {{population}}, {{activePopulation}}'),
	}),
})
