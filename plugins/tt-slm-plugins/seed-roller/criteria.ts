// When the server is judged ready to be rolled onto a seeding layer.
//
// The condition is a javascript expression an admin writes, rather than a set of numeric fields, because the
// real rule is a conjunction nobody can predict ahead of time: a population floor, a time window, some day of
// the week, whichever combination this community's seeding actually depends on. Plugins are trusted
// in-process code, so there is nothing here to sandbox against.

export type TimeVars = {
	hour: number
	minute: number
	/** minutes since local midnight, which is what a time window is naturally written against */
	minutesOfDay: number
	/** 0 = Sunday */
	weekday: number
}

export type CriteriaVars = {
	population: number
	afkPopulation: number
	activePopulation: number
	currentTime: TimeVars
}

export type Compiled = { code: 'ok'; evaluate: (vars: CriteriaVars) => Evaluation } | { code: 'err:compile'; message: string }

export type Evaluation = { code: 'ok'; passed: boolean } | { code: 'err:eval'; message: string }

const VAR_NAMES = ['population', 'afkPopulation', 'activePopulation', 'currentTime'] as const

/**
 * Compiles the expression once, so a syntax error is reported when the config is saved rather than on every
 * evaluation. A throwing expression yields `err:eval` rather than a silent false: an admin who wrote
 * `currentTime.hours` deserves to be told, not to watch the plugin quietly never fire.
 */
export function compile(expression: string): Compiled {
	let fn: (...args: unknown[]) => unknown
	try {
		// the expression is the feature: an admin writes it, and a plugin is trusted in-process code
		// oxlint-disable-next-line typescript-eslint/no-implied-eval
		fn = new Function(...VAR_NAMES, `"use strict"; return (${expression})`) as (...args: unknown[]) => unknown
	} catch (err) {
		return { code: 'err:compile', message: err instanceof Error ? err.message : String(err) }
	}
	return {
		code: 'ok',
		evaluate: (vars) => {
			try {
				return { code: 'ok', passed: !!fn(vars.population, vars.afkPopulation, vars.activePopulation, vars.currentTime) }
			} catch (err) {
				return { code: 'err:eval', message: err instanceof Error ? err.message : String(err) }
			}
		},
	}
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * The wall clock in `timezone`, which is how a seeding window is meant: 2pm local, all year, rather than a
 * UTC offset that slips an hour when daylight saving changes.
 *
 * An unknown zone name falls back to UTC. Intl throws on one, and a time window that silently stops matching
 * is worse than one that matches at the wrong hour and is noticed.
 */
export function timeVars(timezone: string, now: Date): TimeVars {
	let parts: Intl.DateTimeFormatPart[]
	try {
		parts = formatter(timezone).formatToParts(now)
	} catch {
		parts = formatter('UTC').formatToParts(now)
	}
	const part = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
	const hour = Number(part('hour'))
	const minute = Number(part('minute'))
	return { hour, minute, minutesOfDay: hour * 60 + minute, weekday: WEEKDAYS.indexOf(part('weekday')) }
}

export function isValidTimezone(timezone: string): boolean {
	try {
		formatter(timezone)
		return true
	} catch {
		return false
	}
}

function formatter(timeZone: string) {
	return new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' })
}
