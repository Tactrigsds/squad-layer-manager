import * as Templating from 'slm/lib/templating'

// the {{variables}} a task's commands can use, and what each renders as
export const VARIABLES = {
	server: "the server's name in SLM",
	layer: 'the current layer, such as "Gorodok RAAS v1"',
	map: 'the current map',
	gamemode: 'the current gamemode',
	team1: 'the faction on team 1 this match',
	team2: 'the faction on team 2 this match',
	nextLayer: 'the layer set next on the game server',
	nextMap: 'the map set next on the game server',
	players: 'how many players are on the server',
	maxPlayers: 'how many player slots the server has',
	queue: 'how many players are waiting to join',
	matchId: "the current match's id in SLM, which the history page can be filtered by",
	matchMinutes: 'whole minutes since the match started',
	time: "the time of day, as HH:MM in the server's time zone",
	task: "the task's name",
} as const

export type Variable = keyof typeof VARIABLES

export function isVariable(name: string): name is Variable {
	return Object.hasOwn(VARIABLES, name)
}

// the reason a command cannot be rendered, or null
export function commandError(command: string): string | null {
	const vars = Templating.templateVars(command)
	if (vars === undefined) return `"${command}" is not a valid template`
	const unknown = vars.map((v) => v.name).filter((name) => !isVariable(name))
	if (unknown.length > 0) return `"${command}" uses unknown variables: ${unknown.map((n) => `{{${n}}}`).join(', ')}`
	return null
}

// every variable the commands use
export function usedVariables(commands: readonly string[]): Set<Variable> {
	const used = new Set<Variable>()
	for (const command of commands) {
		for (const v of Templating.templateVars(command) ?? []) if (isVariable(v.name)) used.add(v.name)
	}
	return used
}
