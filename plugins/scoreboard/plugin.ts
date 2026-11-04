import * as z from 'zod'

import { definePlugin } from 'slm/plugin'
import { Fields } from 'slm/plugin/fields'

export default definePlugin({
	id: 'scoreboard',
	name: 'Scoreboard',
	version: '1.0.0',
	apiVersion: '^0.22.1',
	description: 'Posts a scoreboard to Discord when a match ends, with leaderboards and charts of the match.',
	configSchema: z.object({
		enabledServers: Fields.serverIds().prefault([]).describe('Servers to post scoreboards for'),
		channel: Fields.discordChannelId().prefault('').describe('The Discord channel scoreboards are posted to'),
		title: z.string().prefault('Scoreboard | {{layer}}').describe('The scoreboard title. Available variables: server, map, layer.'),
		minMatchMinutes: z
			.number()
			.int()
			.min(0)
			.prefault(10)
			.describe('Matches shorter than this many minutes get no scoreboard. Seed and training layers never get one.'),
		leaderboardSize: z.number().int().min(1).max(10).prefault(3).describe('How many entries each leaderboard lists'),
		minKillsForKd: z.number().int().min(1).prefault(10).describe('The fewest kills a player needs to rank for best K/D'),
	}),
})
