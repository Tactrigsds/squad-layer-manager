import { describe, expect, test } from 'vitest'

import * as HQ from './history.models'

const ORIGIN = 'https://slm.example.com'

// the way the router writes a search: json for anything that is not a plain string
const link = (search: string) => `${ORIGIN}/history?${search}`
const SEL = `sel=${encodeURIComponent('["12","40"]')}`

describe('selectionLinksIn', () => {
	test('reads the query and the selection from a link to this app', () => {
		const text = `look at this ${link(`type=events&servers=${encodeURIComponent('["main"]')}&matchId=7&${SEL}`)} please`
		const [found, ...rest] = HQ.selectionLinksIn(text, ORIGIN)
		expect(rest).toEqual([])
		expect(found.sel).toEqual(['12', '40'])
		expect(found.query).toMatchObject({ type: 'events', servers: ['main'], matchId: 7 })
		expect('sel' in found.query).toBe(false)
	})

	test('only links to this app, to the history page, with a selection', () => {
		const text = [`https://elsewhere.example.com/history?${SEL}`, `${ORIGIN}/servers/main?${SEL}`, link('type=events')].join(' ')
		expect(HQ.selectionLinksIn(text, ORIGIN)).toEqual([])
	})

	test('sheds the punctuation after a link, and angle brackets around one', () => {
		const text = `(see <${link(SEL)}>). and ${link(`matchId=3&${SEL}`)}.`
		expect(HQ.selectionLinksIn(text, ORIGIN).map((l) => l.query.matchId)).toEqual([undefined, 3])
	})

	test('the same link twice is quoted once', () => {
		expect(HQ.selectionLinksIn(`${link(SEL)} ${link(SEL)}`, ORIGIN)).toHaveLength(1)
	})
})

describe('negotiateContentType', () => {
	test('the param wins over the header', () => {
		expect(HQ.negotiateContentType('text/html', 'text/plain')).toBe('text/html')
		expect(HQ.negotiateContentType('text/plain', 'text/html')).toBe('text/plain')
	})

	test('the page when nothing asks otherwise', () => {
		expect(HQ.negotiateContentType(undefined, undefined)).toBe('text/html')
		expect(HQ.negotiateContentType(undefined, '*/*')).toBe('text/html')
		expect(HQ.negotiateContentType(undefined, 'application/json')).toBe('text/html')
		// what a browser sends
		expect(HQ.negotiateContentType(undefined, 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')).toBe('text/html')
	})

	test('text when the header prefers it', () => {
		expect(HQ.negotiateContentType(undefined, 'text/plain')).toBe('text/plain')
		expect(HQ.negotiateContentType(undefined, 'text/html;q=0.5, text/plain')).toBe('text/plain')
		// a type's own range outranks the wildcard that also covers it
		expect(HQ.negotiateContentType(undefined, 'text/*;q=1, text/html;q=0.1')).toBe('text/plain')
		expect(HQ.negotiateContentType(undefined, 'TEXT/PLAIN; q=0.9, */*;q=0.1')).toBe('text/plain')
	})

	test('a tie goes to the page', () => {
		expect(HQ.negotiateContentType(undefined, 'text/plain, text/html')).toBe('text/html')
		// and past the page, text before csv
		expect(HQ.negotiateContentType(undefined, 'text/csv, text/plain')).toBe('text/plain')
	})

	test('csv when the header prefers it', () => {
		expect(HQ.negotiateContentType(undefined, 'text/csv')).toBe('text/csv')
		expect(HQ.negotiateContentType(undefined, 'text/csv, text/*;q=0.5')).toBe('text/csv')
	})
})

describe('eventsForRow', () => {
	const base = HQ.parseSearch({ servers: ['main'], feed: 'CHAT', chat: 'gg' })

	test("a player row of a basic query is that query's events for the player, in basic form", () => {
		const players = {
			...base,
			type: 'players' as const,
			players: ['someone-else'],
			playerRole: 'attacker' as const,
			name: 'bo',
			minMatches: 3,
		}
		const narrowed = HQ.eventsForRow(players, 'player:eos1')!
		// the row filters are the result's own, not the events', so the row's player stands in for them
		expect(narrowed).toMatchObject({ type: 'events', mode: 'basic', players: ['eos1'], feed: 'CHAT', chat: 'gg', servers: ['main'] })
		expect(narrowed.playerRole).toBeUndefined()
		expect(narrowed.name).toBeUndefined()
		expect(narrowed.minMatches).toBeUndefined()
		expect(narrowed.q).toBeUndefined()
	})

	test('a match row of a basic query adds the match, and keeps the event filters it has', () => {
		const matches = { ...base, type: 'matches' as const, players: ['eos1'] }
		expect(HQ.eventsForRow(matches, 'match:7')).toMatchObject({
			type: 'events',
			mode: 'basic',
			matchId: 7,
			players: ['eos1'],
			chat: 'gg',
		})
	})

	test('an advanced query has the row anded onto its tree', () => {
		const leaf: HQ.Node = {
			type: 'eq',
			neg: false,
			args: [
				{ type: 'column', column: 'chat.message' },
				{ type: 'value', value: 'gg' },
			],
		}
		const advanced = { ...base, type: 'matches' as const, mode: 'advanced' as const, q: leaf }
		const narrowed = HQ.eventsForRow(advanced, 'match:7')!
		expect(narrowed).toMatchObject({ type: 'events', mode: 'advanced' })
		expect(narrowed.q).toEqual({ type: 'and', children: [leaf, { type: 'match-ids', neg: false, matchIds: [7] }] })
	})
})

describe('rawContentTypes', () => {
	test('events are text alone; players and matches are text and csv', () => {
		expect(HQ.rawContentTypes('events')).toEqual(['text/plain'])
		expect(HQ.rawContentTypes('players')).toEqual(['text/plain', 'text/csv'])
		expect(HQ.rawContentTypes('matches')).toEqual(['text/plain', 'text/csv'])
	})
})

describe('parseSearchParams', () => {
	test('reads the params beside the query, and drops ones that do not parse', () => {
		const params = new URLSearchParams({
			type: 'events',
			contentType: 'text/plain',
			cursor: JSON.stringify({ time: 5, serverEventId: 9 }),
		})
		const { query, contentType, cursor } = HQ.splitSearch(HQ.parseSearchParams(params))
		expect(contentType).toBe('text/plain')
		expect(cursor).toEqual({ time: 5, serverEventId: 9 })
		expect('contentType' in query || 'cursor' in query).toBe(false)

		const bad = HQ.parseSearchParams(new URLSearchParams({ contentType: 'application/pdf', cursor: 'nope' }))
		expect(bad.contentType).toBeUndefined()
		expect(bad.cursor).toBeUndefined()
	})
})
