import * as z from 'zod'

import { definePlugin } from 'slm/plugin'

// defaults preserve the pre-plugin native behaviour: only 150x2 on, at warn
const TriggerLevel = z.enum(['off', 'info', 'warn', 'violation'])

export default definePlugin({
	id: 'balance-triggers',
	name: 'Balance Triggers',
	version: '1.0.0',
	apiVersion: '^2',
	description: 'Watches recent match outcomes and warns admins when they look one-sided.',
	configSchema: z.object({
		levels: z
			.object({
				'150x2': TriggerLevel.prefault('warn').describe('Two consecutive wins by 150+ tickets'),
				'200x2': TriggerLevel.prefault('off').describe('Two consecutive wins by 200+ tickets'),
				RWS5: TriggerLevel.prefault('off').describe('Raw win streak of 5'),
				'RAM3+': TriggerLevel.prefault('off').describe('High rolling average margin over 3+ matches'),
			})
			.prefault({})
			.describe('How loudly each trigger reports'),
		postRollReminder: z.boolean().prefault(true).describe('Warn admins about the most relevant active trigger after each roll'),
	}),
})
