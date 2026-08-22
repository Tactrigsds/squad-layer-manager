// The triggers themselves: pure logic over recent match outcomes, no side effects.
import * as L from 'slm/models/layer'
import * as MH from 'slm/models/match-history'

export type TriggerInput = { history: MH.PostGameMatchDetails[] }
export type Evaluation = {
	strongerTeam: MH.NormedTeamProp
	message: string
	relevantInput: TriggerInput
}
export type Trigger = {
	id: string
	name: string
	version: number
	// higher wins when several triggers are active at once
	priority: number
	evaluate: (input: TriggerInput) => Evaluation | undefined
}

export function isPostGame(m: MH.MatchDetails): m is MH.PostGameMatchDetails {
	return m.status === 'post-game'
}

// a "session" ends at any match whose gamemode resets the balance picture
const SESSION_BREAKERS = ['Training', 'Seed', 'Invasion', 'Destruction', 'Insurgency']

export function sessionSlice(history: MH.PostGameMatchDetails[], n: number): TriggerInput {
	const out: MH.PostGameMatchDetails[] = []
	for (let i = history.length - 1; i >= 0 && out.length < n; i--) {
		if (SESSION_BREAKERS.includes(L.toLayer(history[i].layerId)?.Gamemode as string)) break
		out.unshift(history[i])
	}
	return { history: out }
}

type Win = { margin: number }

function streak(input: TriggerInput): { team: MH.NormedTeamProp; wins: Win[] } | undefined {
	const outcomes = input.history.map((m) => MH.getTeamNormalizedOutcome(m))
	const last = outcomes.at(-1)
	if (!last || (last.type !== 'teamA' && last.type !== 'teamB')) return undefined
	const wins: Win[] = []
	for (let i = outcomes.length - 1; i >= 0; i--) {
		const outcome = outcomes[i]
		if (outcome.type !== last.type) break
		wins.unshift({ margin: Math.abs(outcome.teamATickets - outcome.teamBTickets) })
	}
	return { team: last.type, wins }
}

function marginStreak(id: string, name: string, priority: number, margin: number, count: number): Trigger {
	return {
		id,
		name,
		version: 1,
		priority,
		evaluate: (input) => {
			const s = streak(sessionSlice(input.history, count))
			if (!s || s.wins.length < count) return undefined
			if (!s.wins.slice(-count).every((w) => w.margin >= margin)) return undefined
			return {
				strongerTeam: s.team,
				message: `won the last ${count} matches by ${margin}+ tickets`,
				relevantInput: { history: input.history.slice(-count) },
			}
		},
	}
}

export const TRIGGERS: Trigger[] = [
	marginStreak('150x2', '150+ tickets, twice', 2, 150, 2),
	marginStreak('200x2', '200+ tickets, twice', 3, 200, 2),
	{
		id: 'RWS5',
		name: 'Raw win streak of 5',
		version: 1,
		priority: 4,
		evaluate: (input) => {
			const s = streak(sessionSlice(input.history, 10))
			if (!s || s.wins.length < 5) return undefined
			return {
				strongerTeam: s.team,
				message: 'has won 5 matches in a row',
				relevantInput: { history: input.history.slice(-5) },
			}
		},
	},
	{
		id: 'RAM3+',
		name: 'High rolling average margin',
		version: 1,
		priority: 1,
		evaluate: (input) => {
			const s = streak(sessionSlice(input.history, 6))
			if (!s || s.wins.length < 3) return undefined
			const avg = s.wins.reduce((sum, w) => sum + w.margin, 0) / s.wins.length
			if (avg < 125) return undefined
			return {
				strongerTeam: s.team,
				message: `is averaging ${Math.round(avg)} tickets over ${s.wins.length} matches`,
				relevantInput: { history: input.history.slice(-s.wins.length) },
			}
		},
	},
]

export function highestPriority<T extends { triggerId: string }>(events: T[]): T | undefined {
	const byId = new Map(TRIGGERS.map((t) => [t.id, t.priority]))
	return events.toSorted((a, b) => (byId.get(b.triggerId) ?? 0) - (byId.get(a.triggerId) ?? 0))[0]
}
