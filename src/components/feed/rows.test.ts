// @vitest-environment happy-dom

// The feed's rows are one set of inert templates rendered three ways: serialized on the server, walked to dom on
// the client, and mounted as react children by the short per-player and per-squad feeds. Nothing enforces that but
// this: the dom walker covers only the props the templates use and throws on anything else, and neither renderer
// exercises the app-event branches on any path a type check reaches.
//
// So: every app event type, through both non-react renderers.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { APP_EVENT_TYPE } from '$root/drizzle/enums'
import type * as AppEvents from '@/models/app-events.models'
import type * as CHAT from '@/models/chat.models'
import type * as SM from '@/models/squad.models'

import type * as RC from './render-context'
import { Row } from './rows'
import { renderStatic } from './static-render'

const MATCH_ID = 1

const player = (eos: string, username: string): SM.Player => ({
	ids: { eos, username, steam: '76561198000000000' },
	teamId: 1 as SM.TeamId,
	squadId: 1,
	isLeader: false,
	isAdmin: false,
	role: '',
})

const CTX: RC.RenderCtx = {
	scopeId: 'test',
	stores: {} as never,
	outletKey: 'default',
	zIndexBase: 0,
	displayTeamsNormalized: true,
	showTeamlessChat: true,
	placeholderUndrawn: true,
	matchById: () => undefined,
	latestMatch: undefined,
	currentMatch: undefined,
	groupColor: () => null,
	userLabel: () => 'Some Admin',
	pluginName: () => 'Some Plugin',
}

// the payload each type needs beyond the envelope, kept to the fields its template actually reads
const PAYLOADS: Record<string, Record<string, unknown>> = {
	PLAYER_WARNED: { message: 'stop that', targets: ['eos1'] },
	SQUAD_DISBANDED: { teamId: 1, squadId: 1, squadName: 'Squad 1', members: ['eos1'] },
	PLAYER_REMOVED_FROM_SQUAD: { targets: ['eos1'] },
	TEAM_CHANGE_FORCED: { targets: ['eos1'] },
	PLAYER_KILLED: { targets: ['eos1'] },
	SQUAD_RENAMED: { teamId: 1, squadId: 1, squadName: 'Squad 1' },
	COMMANDER_DEMOTED: { target: 'eos1' },
	FOG_OF_WAR_TOGGLED: { enabled: true },
	RCON_COMMAND_RUN: { command: 'AdminListDisconnectedPlayers' },
	MATCH_ENDED: {},
	VOTE_STARTED: { choiceCount: 3 },
	VOTE_ENDED: { reason: 'vote-timeout', winnerLayerId: 'GD-RAAS-V1:USA-CA:RGF-CA' },
	VOTE_ABORTED: {},
	// a real net change, so the expandable per-change lines render rather than the bare summary
	QUEUE_UPDATED: {
		trigger: 'user-edit',
		ops: [],
		prevList: [],
		list: [{ type: 'single-list-item', itemId: 'i1', layerId: 'GD-RAAS-V1:USA-CA:RGF-CA', source: { type: 'manual', userId: 1n } }],
		save: { force: true, overrodeEditors: [2n] },
	},
	SETTINGS_UPDATED: { changes: [] },
	SERVER_REGISTRY_CHANGED: { action: 'added', serverId: 's1' },
	FILTER_CHANGED: { action: 'created', filterId: 'f1', filterName: 'f' },
	FILTER_CONTRIBUTOR_CHANGED: { action: 'added', filterId: 'f1', filterName: 'f' },
	USER_ACCOUNT_CHANGED: { action: 'created', targetUserId: 1n },
	PLAYER_FLAGS_UPDATED: { playerId: 'eos1', added: [], removed: [] },
	PLAYER_NOTE_ADDED: { playerId: 'eos1', note: 'mic spam' },
	APP_STARTED: {},
	APP_RESTARTED: {},
	ANNOUNCEMENT_SENT: { message: 'restarting soon', expiresAt: 0 },
	PERMISSION_DENIED: { procedure: 'squadServer.endMatch', failures: ['squad-server:end-match'] },
	BACKUP_CREATED: { filename: 'b.db', sizeBytes: 1 },
	MAP_SET: { layerId: 'GD-RAAS-V1:USA-CA:RGF-CA', reason: 'override', overrode: { type: 'rcon' } },
	PLUGIN_EVENT: { pluginId: 'p', name: 'thing', message: 'a thing happened', payload: {} },
	PLUGIN_DATA_PURGED: { pluginId: 'p', tables: [] },
	SCHEDULED_JOB_SUCCESS: { pluginId: 'p', jobId: 'j', key: '@0', scheduledFor: 0, manual: true, attempt: 1 },
	SCHEDULED_JOB_FAILED: { pluginId: 'p', jobId: 'j', key: '@0', scheduledFor: 0, manual: false, attempt: 3, error: 'boom' },
	SCHEDULED_JOB_CANCELLED: { pluginId: 'p', jobId: 'j', key: '@0', scheduledFor: 0, manual: false, attempt: 1 },
	// more targets than the inline limit, so the collapsed <details> branch renders instead
	PLAYER_KICKED: { targets: ['eos1', 'eos2', 'eos3', 'eos4', 'eos5'] },
	PLAYER_TIMED_OUT: { target: 'eos1', durationMs: 60_000 },
	TIMEOUT_CANCELLED: { target: 'eos1' },
	BROADCAST_SENT: { message: 'hello' },
	MATCH_LAYERS_RECONCILED: { layerDataHash: 'h', matchesUpdated: 0, resolved: [], unresolvedRemaining: 0 },
	TEAMSWAPS_UPDATED: {
		trigger: 'saved',
		prevSwaps: new Map(),
		swaps: new Map([['eos1', { toTeam: 'A', source: { discordId: 2n, origin: 'gui' } }]]),
	},
	SWITCH_REQUESTS_FULFILLED: { targets: ['eos1'] },
	LAYER_REQUEST_ADDED: { itemId: 'i', description: 'd' },
	LAYER_REQUEST_REMOVED: { itemIds: ['i'], descriptions: ['d'] },
	LAYER_REQUEST_CONSUMED: { itemIds: ['i'], descriptions: ['d'], layerId: 'GD-RAAS-V1:USA-CA:RGF-CA' },
}

function entry(type: string): CHAT.EventEnriched {
	const appEvent = {
		id: 'ae1',
		type,
		time: 1_700_000_000_000,
		actor: { type: 'slm-user', userId: 1n },
		serverId: 's1',
		matchId: MATCH_ID,
		causeId: null,
		instanceId: null,
		...PAYLOADS[type],
	} as unknown as AppEvents.AppEvent
	return {
		type: 'APP_EVENT',
		id: 'ae1',
		time: appEvent.time,
		matchId: MATCH_ID,
		appEvent,
		targetPlayers: [player('eos1', 'Target'), player('eos2', 'Other')],
		warnSummary: { type: 'players' },
		collapsed: [],
		targetSquadIds: [],
	}
}

describe('app event rows render on every path', () => {
	// every type, so a new one cannot be added without a template that both renderers accept
	it.each(APP_EVENT_TYPE.options)('%s', (type) => {
		const event = entry(type)
		expect(() => renderToStaticMarkup(createElement(Row, { ctx: CTX, event }))).not.toThrow()
		expect(() => renderStatic(createElement(Row, { ctx: CTX, event }))).not.toThrow()
	})
})

describe('a destroyed vehicle folds a large crew away', () => {
	const destroyed = (crewSize: number) =>
		({
			type: 'VEHICLE_DESTROYED',
			id: 'se1',
			time: 1_700_000_000_000,
			matchId: MATCH_ID,
			vehicle: { className: 'BP_BTR80_Militia', instanceId: '1', targetType: null },
			teamId: null,
			cause: 'weapon',
			damageType: null,
			weapon: null,
			variant: 'normal',
			attacker: player('eos0', 'Attacker'),
			crew: Array.from({ length: crewSize }, (_, i) => player(`eos${i + 1}`, `Crew${i + 1}`)),
		}) as unknown as CHAT.EventEnriched

	it('names a small crew inline', () => {
		const html = renderToStaticMarkup(createElement(Row, { ctx: CTX, event: destroyed(2) }))
		expect(html).not.toContain('<details')
		expect(html).toContain('crew: ')
		expect(() => renderStatic(createElement(Row, { ctx: CTX, event: destroyed(2) }))).not.toThrow()
	})

	it('counts a large crew and lists it on expand', () => {
		const html = renderToStaticMarkup(createElement(Row, { ctx: CTX, event: destroyed(15) }))
		expect(html).toContain('<details')
		expect(html).toContain('crew of 15')
		expect(html).toContain('Crew15')
		expect(() => renderStatic(createElement(Row, { ctx: CTX, event: destroyed(15) }))).not.toThrow()
	})
})

describe('bursts render on every path', () => {
	const attacker = player('eos0', 'Attacker')
	const envelope = (id: number) => ({ id, time: 1_700_000_000_000 + id, matchId: MATCH_ID })
	const target = { className: 'BP_BTR80_Militia', instanceId: 1, targetType: null }
	const member: Record<CHAT.BurstKind, (id: number) => object> = {
		PLAYER_WARNED: (id) => ({ type: 'PLAYER_WARNED', ...envelope(id), reason: 'stop', player: player(`eos${id}`, `Warned${id}`) }),
		PLAYER_WOUNDED: (id) => ({
			type: 'PLAYER_WOUNDED',
			...envelope(id),
			damage: 100,
			damageSource: 'BP_Mortar',
			variant: 'normal',
			victim: player(`eos${id}`, `Victim${id}`),
			attacker,
		}),
		PLAYER_DIED: (id) => ({
			type: 'PLAYER_DIED',
			...envelope(id),
			damage: 100,
			deathVariant: 'killed',
			damageSource: 'BP_Mortar',
			variant: 'teamkill',
			victim: player(`eos${id}`, `Victim${id}`),
			attacker,
		}),
		VEHICLE_DAMAGED: (id) => ({
			type: 'VEHICLE_DAMAGED',
			...envelope(id),
			vehicle: target,
			teamId: null,
			damage: 40.4,
			damageType: null,
			weapon: 'BP_RPG7',
			variant: 'normal',
			attacker,
		}),
		VEHICLE_DESTROYED: (id) => ({
			type: 'VEHICLE_DESTROYED',
			...envelope(id),
			vehicle: { ...target, instanceId: id },
			teamId: null,
			cause: 'weapon',
			damageType: null,
			weapon: 'BP_RPG7',
			variant: 'normal',
			crew: [],
			attacker,
		}),
		DEPLOYABLE_DESTROYED: (id) => ({
			type: 'DEPLOYABLE_DESTROYED',
			...envelope(id),
			deployable: { className: 'BP_Ammocrate_PLA', instanceId: id, targetType: 'AMMO_CRATE' },
			teamId: null,
			cause: 'weapon',
			damageType: null,
			weapon: null,
			variant: 'normal',
			attacker,
		}),
	}

	it.each(Object.keys(member) as CHAT.BurstKind[])('%s', (kind) => {
		// past the inline limit, so a warn burst renders its collapsed <details> too
		const events = [1, 2, 3, 4, 5].map(member[kind])
		const event = { type: 'BURST', ...envelope(1), kind, events } as unknown as CHAT.EventEnriched
		const html = renderToStaticMarkup(createElement(Row, { ctx: CTX, event }))
		expect(html).toContain('<details')
		expect(html).toContain('5')
		expect(() => renderStatic(createElement(Row, { ctx: CTX, event }))).not.toThrow()
	})
})

describe('vehicle changes render on every path', () => {
	const seat = (n: number) => ({ className: 'BP_BTR80_Militia', instanceId: 1, targetType: null, seat: n, pawn: 'BP_BTR80_Militia' })
	const change = (from: number | null, to: number | null) =>
		({
			type: 'PLAYER_VEHICLE_CHANGED',
			id: 1,
			time: 1_700_000_000_000,
			matchId: MATCH_ID,
			player: player('eos1', 'Driver'),
			from: from === null ? null : seat(from),
			to: to === null ? null : seat(to),
		}) as unknown as CHAT.EventEnriched

	it.each([
		['an enter', null, 0, /got into .* seat 0/],
		['a move', 0, 2, /moved to seat 2 of /],
		['an exit', 1, null, /got out of /],
	] as const)('%s', (_, from, to, text) => {
		const event = change(from, to)
		const html = renderToStaticMarkup(createElement(Row, { ctx: CTX, event }))
		expect(html.replace(/<[^>]+>/g, '')).toMatch(text)
		expect(() => renderStatic(createElement(Row, { ctx: CTX, event }))).not.toThrow()
	})
})
