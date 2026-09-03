import * as z from 'zod'

import { definePlugin } from 'slm/plugin'
import { Fields } from 'slm/plugin/fields'

export default definePlugin({
	id: 'teamkill-warns',
	name: 'Teamkill Warns',
	version: '1.0.0',
	apiVersion: '^0.6',
	description: "Warns players when they've been teamkilled",
	configSchema: z.object({
		enabledServers: Fields.serverIds().prefault([]).describe('Servers to enable teamkill warns for'),
		template: Fields.multilineText()
			.prefault('You have been teamkilled by {{attacker}} with {{weapon}}. An admin has been notified.')
			.describe('The warn sent to the victim. Available variables: attacker, weapon.'),
	}),
})
