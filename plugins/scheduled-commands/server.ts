import type * as P from 'slm/plugin'
import * as Schedule from 'slm/plugin/schedule'
import * as Settings from 'slm/systems/settings'
import * as SquadRcon from 'slm/systems/squad-rcon'
import * as SquadServer from 'slm/systems/squad-server'

import type manifest from './plugin.ts'
import { jobIdOf } from './plugin.ts'

type Config = P.Config<typeof manifest>
type Task = Config['tasks'][number]

export async function activate(_ctx: P.Ctx<typeof manifest>) {}

// one job per task, so each shows in settings with its own schedule, last run and Run now
export function jobs(cfg: Config) {
	return cfg.tasks.map(taskJob)
}

function taskJob(task: Task) {
	return Schedule.job({
		id: jobIdOf(task.name),
		label: task.name,
		scope: 'server',
		// a broadcast meant for the start of a match is wrong ten minutes in
		catchUp: '1m',
		when: (_cfg: Config, serverId) => (serverId !== null && task.servers.includes(serverId) ? specOf(task.trigger) : null),
		run: async (sctx: P.ServerCtx<typeof manifest>, run) => {
			const playerCount = SquadServer.getCurrTeams(sctx)?.players.size ?? 0
			if (!run.manual && playerCount < task.minPlayers) {
				sctx.log.info('skipping %s: %d players, %d required', task.name, playerCount, task.minPlayers)
				return
			}
			const failures: string[] = []
			for (const command of task.commands) {
				const res = await SquadRcon.execute(sctx, command)
				if (res.code !== 'ok') failures.push(`"${command}": ${res.msg}`)
			}
			if (failures.length > 0) throw new Error(`${failures.length} of ${task.commands.length} commands failed: ${failures.join('; ')}`)
		},
	})
}

function specOf(trigger: Task['trigger']): Schedule.Spec {
	switch (trigger.type) {
		case 'interval':
			return { every: trigger.every }
		case 'cron':
			// the default time zone setting can itself be 'server', which the scheduler reads as this server's zone
			return { cron: trigger.cron, timezone: trigger.timezone ?? Settings.global().defaultTimeZone }
		case 'match-start':
			return Schedule.afterMatchStart(trigger.after, trigger.repeatEvery === null ? undefined : { every: trigger.repeatEvery })
		case 'round-end':
			return Schedule.afterMatchEnd(trigger.after)
		default:
			return assertNever(trigger)
	}
}

function assertNever(value: never): never {
	throw new Error(`unhandled trigger: ${JSON.stringify(value)}`)
}
