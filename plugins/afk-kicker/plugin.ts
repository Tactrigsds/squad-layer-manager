import * as z from 'zod'

import * as ZU from 'slm/lib/zod-utils'
import { definePlugin } from 'slm/plugin'
import { Fields } from 'slm/plugin/fields'

export default definePlugin({
	id: 'afk-kicker',
	name: 'AFK Kicker',
	version: '1.0.0',
	apiVersion: '^0.8.1',
	description: 'Kicks AFK players when people are waiting in the queue, longest AFK first.',
	configSchema: z.object({
		// empty means no servers: kicking players is not something to start doing because a plugin was installed
		enabledServers: Fields.serverIds().prefault([]).describe('Servers the AFK kicker runs on. Empty runs on none.'),
		targetQueue: z
			.int()
			.prefault(0)
			.describe('How many players to leave waiting in the queue. A negative number keeps that many slots open instead.'),
		squadlessWindow: ZU.HumanTime.prefault('5m').describe(
			'Outside the gamemodes below, how long a player can stay out of a squad before they count as AFK',
		),
		idleWindow: ZU.HumanTime.prefault('15m').describe(
			'On the gamemodes below, how long since a player last did anything before they count as AFK',
		),
		idleGamemodes: z
			.array(z.string())
			.prefault(['Seed', 'Training'])
			.describe('Gamemodes where players count as AFK for inactivity rather than for being out of a squad'),
		warnInterval: ZU.HumanTime.prefault('1m').describe('How often AFK players are warned while the server is full'),
		warning: Fields.multilineText()
			.prefault('You are AFK because {{reason}}. You will be kicked if players are waiting to join.')
			.describe('Warned to AFK players while the server is full. Variables: {{reason}}'),
		finalWarning: Fields.multilineText()
			.prefault('You are AFK because {{reason}}. You will be kicked in {{seconds}} seconds.')
			.describe('Warned to a player just before they are kicked. Variables: {{reason}}, {{seconds}}'),
		kickReason: z.string().prefault('AFK while players were waiting to join').describe('Shown to a kicked player'),
	}),
})
