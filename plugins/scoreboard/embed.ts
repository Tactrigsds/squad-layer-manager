import * as Templating from 'slm/lib/templating'
import * as L from 'slm/models/layer'
import * as MH from 'slm/models/match-history'
import type * as SM from 'slm/models/squad'
import type * as P from 'slm/plugin'
import type * as Discord from 'slm/systems/discord'

import * as Charts from './charts.ts'
import type manifest from './plugin.ts'
import * as Stats from './stats.ts'

const TEAM_COLORS = { 1: '#3ec6b4', 2: '#f28b5c' } as const
const EMBED_COLOR = 0xf2b632
// discord refuses a message whose embeds hold more text than this, counted across all of them
const EMBEDS_TEXT_LIMIT = 6000
const MAX_NAME_LENGTH = 32

export const KILLS_CHART_FILE = 'kills.png'
export const TICKETS_CHART_FILE = 'tickets.png'

export type Charted = { kills: string; tickets: string | null }

type Fields = NonNullable<Discord.Embed['fields']>

/** The scoreboard's embeds, and the SVG of each chart they reference by file name. */
export function build(opts: {
	cfg: P.Config<typeof manifest>
	match: MH.PostGameMatchDetails
	tally: Stats.MatchTally
	serverName: string | null
	// set when the channel could be holding scoreboards from more than one real server
	showServer: boolean
}): { embeds: Discord.Embed[]; charts: Charted } {
	const { cfg, match, tally } = opts
	const layer = L.toLayer(match.layerId)
	const teamName = (teamId: SM.TeamId) => MH.getTeamFaction(match, teamId) ?? `Team ${teamId}`
	const title = Templating.renderTemplate(cfg.title, {
		server: opts.serverName ?? '',
		map: layer.Map ?? '',
		layer: (layer.Layer ?? L.toLayerText(match.layerId)).replaceAll('_', ' '),
	})

	const kills = [tally.killTimes[0].length, tally.killTimes[1].length]
	const lines = [`${teamName(1)} (${plural(kills[0], 'kill')}) vs ${teamName(2)} (${plural(kills[1], 'kill')})`]
	const minutes = matchMinutes(match)
	const outcome = match.outcome
	switch (outcome.type) {
		case 'team1':
		case 'team2': {
			const winner = outcome.type === 'team1' ? 1 : 2
			const tickets = winner === 1 ? outcome.team1Tickets : outcome.team2Tickets
			lines.push(`${teamName(winner)} won with ${tickets} tickets${minutes === null ? '' : ` in ${minutes} minutes`}.`)
			break
		}
		case 'draw':
			lines.push(`Draw${minutes === null ? '' : ` after ${minutes} minutes`}.`)
			break
		case 'unknown':
			break
		default:
			outcome satisfies never
	}
	const description = lines.join('\n')
	const footer = { text: `Match ${match.historyEntryId}` }
	const author = opts.showServer && opts.serverName ? { name: opts.serverName } : undefined
	const header = (author?.name ?? '') + title + description + footer.text

	const playerList = [...tally.players.values()]
	let size = cfg.leaderboardSize
	let fields = leaderboards({ cfg, tally, playerList, size, teamName })
	while (size > 1 && textLength(header, fields) > EMBEDS_TEXT_LIMIT) {
		size--
		fields = leaderboards({ cfg, tally, playerList, size, teamName })
	}

	const start = match.startTime?.getTime() ?? null
	const end = match.endTime instanceof Date ? match.endTime.getTime() : null
	const origin = start ?? tally.tickets[0]?.time ?? Math.min(tally.killTimes[0][0] ?? Infinity, tally.killTimes[1][0] ?? Infinity)
	const lastEvent = Math.max(tally.killTimes[0].at(-1) ?? 0, tally.killTimes[1].at(-1) ?? 0, tally.tickets.at(-1)?.time ?? 0)
	const xMax = Math.max((end ?? lastEvent) - origin, lastEvent - origin)

	const teams = [1, 2] as const
	const killsSvg = Charts.lineChart({
		title: 'Kills',
		xMax,
		series: teams.map((teamId) => ({
			label: teamName(teamId),
			color: TEAM_COLORS[teamId],
			points: [{ x: 0, y: 0 }, ...tally.killTimes[teamId - 1].map((time, i) => ({ x: time - origin, y: i + 1 }))],
		})),
	})
	const ticketsSvg =
		tally.tickets.length === 0
			? null
			: Charts.lineChart({
					title: 'Tickets',
					xMax,
					fitY: true,
					series: teams.map((teamId) => ({
						label: teamName(teamId),
						color: TEAM_COLORS[teamId],
						points: tally.tickets.map((sample) => ({ x: sample.time - origin, y: sample.tickets[teamId - 1] })),
					})),
				})

	const timestamp = end === null ? undefined : new Date(end).toISOString()
	const main: Discord.Embed = {
		author,
		title,
		description,
		color: EMBED_COLOR,
		fields,
		image: { url: `attachment://${KILLS_CHART_FILE}` },
	}
	const embeds: Discord.Embed[] = [main]
	if (ticketsSvg) embeds.push({ color: EMBED_COLOR, image: { url: `attachment://${TICKETS_CHART_FILE}` } })
	Object.assign(embeds[embeds.length - 1], { footer, timestamp })

	return { embeds, charts: { kills: killsSvg, tickets: ticketsSvg } }
}

/** Whole minutes from start to end, or null when either end is unknown. */
export function matchMinutes(match: MH.PostGameMatchDetails): number | null {
	if (!match.startTime || !(match.endTime instanceof Date)) return null
	return Math.round((match.endTime.getTime() - match.startTime.getTime()) / 60_000)
}

function leaderboards(opts: {
	cfg: P.Config<typeof manifest>
	tally: Stats.MatchTally
	playerList: Stats.PlayerTally[]
	size: number
	teamName: (teamId: SM.TeamId) => string
}): Fields {
	const { cfg, tally, playerList, size, teamName } = opts
	const fields: Fields = []
	const board = <T extends { name: string }>(
		name: string,
		ranked: Stats.Ranked<T>[],
		format: (ranked: Stats.Ranked<T>) => string = (r) => String(r.value),
	) => {
		if (ranked.length === 0) return
		fields.push({
			name,
			value: ranked.map((r, i) => `${i + 1}. ${escapeMarkdown(truncate(r.item.name))} - ${format(r)}`).join('\n'),
			inline: true,
		})
	}

	board(
		'Top Fraggers',
		playerList
			.filter((p) => p.kills > 0 || p.downs > 0)
			.sort((a, b) => b.kills - a.kills || b.downs - a.downs)
			.slice(0, size)
			.map((p) => ({ item: p, value: p.kills })),
		(r) => `${plural(r.value, 'kill')}, ${plural(r.item.downs, 'down')}`,
	)
	board(
		'Squad Kills',
		Stats.top(tally.squads.values(), (s) => s.kills, size).map((r) => ({
			...r,
			item: { name: `${r.item.name} (${teamName(r.item.teamId)})` },
		})),
	)
	board(
		'Combat Medic',
		Stats.top(playerList, (p) => p.revives, size),
	)
	board(
		'Vehicles',
		playerList
			.filter((p) => p.vehicleDamage > 0 || p.vehicleKills > 0)
			.sort((a, b) => b.vehicleDamage - a.vehicleDamage || b.vehicleKills - a.vehicleKills)
			.slice(0, size)
			.map((p) => ({ item: p, value: p.vehicleDamage })),
		(r) => `${Math.round(r.value)} dmg, ${plural(r.item.vehicleKills, 'kill')}`,
	)
	board(
		'FOB/HAB Destroyer',
		Stats.top(playerList, (p) => p.deployableKills, size),
	)
	board(
		'Longest Kill Streak',
		Stats.top(playerList, (p) => p.longestStreak, size),
	)
	board(
		'Best K/D',
		Stats.top(
			playerList.filter((p) => p.kills >= cfg.minKillsForKd),
			Stats.kd,
			size,
		),
		(r) => r.value.toFixed(2),
	)
	board(
		'Most Deaths',
		Stats.top(playerList, (p) => p.deaths, size),
	)
	board(
		'Most Teamkills',
		Stats.top(playerList, (p) => p.teamkills, size),
	)
	return fields
}

function textLength(header: string, fields: Fields): number {
	let length = header.length
	for (const field of fields) length += field.name.length + field.value.length
	return length
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function truncate(name: string): string {
	return name.length > MAX_NAME_LENGTH ? `${name.slice(0, MAX_NAME_LENGTH - 1)}…` : name
}

function escapeMarkdown(text: string): string {
	return text.replace(/([\\*_~`|[\]<])/g, '\\$1')
}
