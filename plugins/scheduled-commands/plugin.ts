import * as z from 'zod'

import * as ZU from 'slm/lib/zod-utils'
import { definePlugin } from 'slm/plugin'
import { Fields } from 'slm/plugin/fields'

import * as Vars from './variables.ts'

const MIN_INTERVAL_MS = 10_000

// a task's job id, which the scheduler keys its runs by
export function jobIdOf(taskName: string) {
	return taskName
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64)
}

const Trigger = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('interval'),
		every: ZU.HumanTime.prefault('15m').describe('How long to wait after a run finishes before the next. At least 10s.'),
	}),
	z.object({
		type: z.literal('cron'),
		cron: z.string().prefault('0 20 * * *').describe('A cron pattern, such as "0 20 * * *" for 20:00 every day'),
		timezone: z
			.string()
			.nullable()
			.prefault(null)
			.describe('An IANA time zone, such as "Europe/Berlin". Empty uses the default time zone.'),
	}),
	z.object({
		type: z.literal('match-start'),
		after: ZU.HumanTime.prefault('5m').describe('How long after the match starts to run'),
		repeatEvery: ZU.HumanTime.nullable()
			.prefault(null)
			.describe('Run again this often until the match ends. Empty runs once per match. At least 10s.'),
	}),
	z.object({
		type: z.literal('round-end'),
		after: ZU.HumanTime.prefault('0s').describe('How long after the match ends to run. Skipped if the next match has started by then.'),
	}),
])

const Task = z
	.object({
		name: z.string().trim().min(1).describe('Names the task in settings. Must be unique.'),
		description: z.string().trim().prefault('').describe('What the task is for. Shown under its name in the list of jobs.'),
		servers: Fields.serverIds().prefault([]).describe('Servers the task runs on. Empty runs on none.'),
		trigger: Trigger.prefault({ type: 'interval' }).describe('When the commands run'),
		commands: z
			.array(
				z
					.string()
					.trim()
					.min(1)
					.superRefine((command, ctx) => {
						const error = Vars.commandError(command)
						if (error) ctx.addIssue({ code: 'custom', message: error })
					}),
			)
			.min(1)
			.describe(
				`RCON commands, run in order, such as "AdminBroadcast Now playing {{layer}}". Variables: ${Object.keys(Vars.VARIABLES)
					.map((name) => `{{${name}}}`)
					.join(', ')}`,
			),
		minPlayers: z.int().min(0).prefault(0).describe('Skip a scheduled run while fewer players than this are on the server'),
	})
	.refine((t) => jobIdOf(t.name) !== '', { message: 'A task name needs at least one letter or number', path: ['name'] })
	.refine((t) => t.trigger.type !== 'interval' || t.trigger.every >= MIN_INTERVAL_MS, {
		message: 'An interval must be at least 10s',
		path: ['trigger', 'every'],
	})
	.refine((t) => t.trigger.type !== 'match-start' || t.trigger.repeatEvery === null || t.trigger.repeatEvery >= MIN_INTERVAL_MS, {
		message: 'A repeat interval must be at least 10s',
		path: ['trigger', 'repeatEvery'],
	})

export default definePlugin({
	id: 'scheduled-commands',
	name: 'Scheduled Commands',
	version: '1.1.0',
	apiVersion: '^0.22.2',
	description: 'Runs RCON commands on a timer, at set times, or a set time after a match starts or ends.',
	configSchema: z.object({
		tasks: z
			.array(Task)
			.prefault([])
			.refine((tasks) => new Set(tasks.map((t) => jobIdOf(t.name))).size === tasks.length, {
				message: 'Task names must be unique, ignoring case and punctuation',
			})
			.describe('Each task runs its commands whenever its trigger fires'),
	}),
})
