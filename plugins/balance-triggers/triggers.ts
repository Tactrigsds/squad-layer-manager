// The triggers themselves: pure logic over recent match outcomes, no side effects.
import * as L from 'slm/models/layer'
import * as MH from 'slm/models/match-history'

export type TriggerInput = { history: MH.MatchDetails[] }
export type Evaluation = {
	strongerTeam: MH.NormedTeamProp
	// the sentence the UI shows, with {{strongerTeam}} left for the reader to substitute: which team
	// that is reads differently depending on the match it is shown against
	message: string
	relevantInput: { history: MH.PostGameMatchDetails[] }
}
export type Trigger = {
	id: string
	name: string
	version: number
	evaluate: (input: TriggerInput) => Evaluation | undefined
}

// a "session" ends at any match whose gamemode resets the balance picture
const SESSION_BREAKERS = ['Training', 'Seed', 'Invasion', 'Destruction', 'Insurgency']

// The last up-to-n matches of the current session, newest last. The still-in-progress match after the
// one just finalized is skipped; any earlier match without an outcome ends the session rather than
// being skipped over, so a gap in the record can't stitch two runs into one streak.
export function sessionSlice(history: MH.MatchDetails[], n: number): MH.PostGameMatchDetails[] {
	const out: MH.PostGameMatchDetails[] = []
	for (let i = history.length - 1; i >= 0 && out.length < n; i--) {
		const match = history[i]
		if (match.status !== 'post-game') {
			if (i === history.length - 1) continue
			break
		}
		if (SESSION_BREAKERS.includes(L.toLayer(match.layerId)?.Gamemode as string)) break
		out.unshift(match)
	}
	return out
}

type Win = { margin: number }

function streak(session: MH.PostGameMatchDetails[]): { team: MH.NormedTeamProp; wins: Win[] } | undefined {
	const outcomes = session.map((m) => MH.getTeamNormalizedOutcome(m))
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

function marginStreak(id: string, name: string, margin: number, count: number): Trigger {
	return {
		id,
		name,
		version: 1,
		evaluate: (input) => {
			const session = sessionSlice(input.history, count)
			const s = streak(session)
			if (!s || s.wins.length < count) return undefined
			if (!s.wins.slice(-count).every((w) => w.margin >= margin)) return undefined
			return {
				strongerTeam: s.team,
				message: `{{strongerTeam}} has won ${count} games by ${margin}+ tickets.`,
				relevantInput: { history: session.slice(-count) },
			}
		},
	}
}

export const TRIGGERS: Trigger[] = [
	marginStreak('150x2', '150 tickets x2', 150, 2),
	marginStreak('200x2', '200 tickets x2', 200, 2),
	{
		id: 'RWS5',
		name: 'Raw Win Streak Across 5',
		version: 1,
		evaluate: (input) => {
			const session = sessionSlice(input.history, 10)
			const s = streak(session)
			if (!s || s.wins.length < 5) return undefined
			return {
				strongerTeam: s.team,
				message: '{{strongerTeam}} has won five games in a row.',
				relevantInput: { history: session.slice(-5) },
			}
		},
	},
	{
		id: 'RAM3+',
		name: 'Maximum Rolling Average Across 3+',
		version: 1,
		evaluate: (input) => {
			const session = sessionSlice(input.history, 6)
			const s = streak(session)
			if (!s || s.wins.length < 3) return undefined
			const avg = s.wins.reduce((sum, w) => sum + w.margin, 0) / s.wins.length
			if (avg < 125) return undefined
			return {
				strongerTeam: s.team,
				message: `{{strongerTeam}} has been winning for ${s.wins.length} games with an average of (125+)(${avg.toFixed(2)}) tickets`,
				relevantInput: { history: session.slice(-s.wins.length) },
			}
		},
	},
]
