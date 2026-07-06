import { describe, expect, it } from 'vitest'

import * as ST from '@/lib/state-tree'
import * as UP from './user-presence'

const serverId = 'server-1'

// Rebuild an activity from its serialized updates, mirroring how the reducer applies them.
function rebuild(activity: UP.RootActivity | null): UP.RootActivity | null {
	if (!activity) return null
	return UP.activityToUpdates(activity).reduce<UP.RootActivity | null>(
		(acc, update) => UP.applyActivityUpdate(acc, update),
		null,
	)
}

describe('activityToUpdates', () => {
	it('round-trips a bare server dashboard', () => {
		const activity = UP.applyActivityUpdate(null, { code: 'enter-server-dashboard', serverId })
		expect(rebuild(activity)).toEqual(activity)
	})

	it('round-trips viewing the queue with settings open', () => {
		let activity = UP.applyActivityUpdate(null, { code: 'enter-server-dashboard', serverId })
		activity = UP.applyActivityUpdate(activity, { code: 'set-primary-panel', to: 'VIEWING_QUEUE', serverId })
		activity = UP.applyActivityUpdate(activity, { code: 'set-viewing-queue-settings' })
		activity = UP.applyActivityUpdate(activity, { code: 'set-changing-queue-settings' })
		expect(rebuild(activity)).toEqual(activity)
	})

	it('round-trips viewing teams with a player dialogue', () => {
		let activity = UP.applyActivityUpdate(null, { code: 'enter-server-dashboard', serverId })
		activity = UP.applyActivityUpdate(activity, { code: 'set-primary-panel', to: 'VIEWING_TEAMS', serverId })
		activity = UP.applyActivityUpdate(activity, { code: 'set-player-dialogue', dialog: UP.PLAYER_DIALOGUE_ID.options[0] })
		expect(rebuild(activity)).toEqual(activity)
	})

	it('round-trips editing the queue and teamswitches simultaneously', () => {
		let activity = UP.applyActivityUpdate(null, { code: 'enter-server-dashboard', serverId })
		activity = UP.applyActivityUpdate(activity, {
			code: 'set-editing-queue',
			variant: ST.Match.leaf('IDLE', {}) as UP.QueueEditingActivity<'IDLE'>,
		})
		activity = UP.applyActivityUpdate(activity, { code: 'set-editing-teamswitches' })
		expect(rebuild(activity)).toEqual(activity)
	})

	it('round-trips an item-owned editing activity', () => {
		let activity = UP.applyActivityUpdate(null, { code: 'enter-server-dashboard', serverId })
		activity = UP.applyActivityUpdate(activity, {
			code: 'set-editing-queue',
			variant: ST.Match.leaf('EDITING_ITEM', { itemId: 'item-42', cursor: { type: 'start' } }) as UP.QueueEditingActivity,
		})
		expect(rebuild(activity)).toEqual(activity)
	})
})

describe('reducer enabled-server gating', () => {
	const clientOp = (op: Partial<UP.Op> & { code: UP.Op['code'] }): UP.Op =>
		({ opId: 'op-' + Math.random(), time: Date.now(), clientId: 'client-1', userId: 1n, ...op }) as UP.Op

	const stateWith = (enabled: string[]): UP.State => ({ ...UP.initState(), enabledServers: new Set(enabled) })

	it('collapses presence to null when a client enters a non-enabled server', () => {
		const [next] = UP.reducer(
			stateWith(['server-1']),
			[clientOp({ code: 'update-activity', update: { code: 'enter-server-dashboard', serverId: 'server-2' } })],
			[],
		)
		expect(next.presence.get('client-1')?.activityState).toBeNull()
	})

	it('keeps presence when a client enters an enabled server', () => {
		const [next] = UP.reducer(
			stateWith(['server-1']),
			[clientOp({ code: 'update-activity', update: { code: 'enter-server-dashboard', serverId: 'server-1' } })],
			[],
		)
		expect(next.presence.get('client-1')?.activityState?.opts.serverId).toBe('server-1')
	})

	it('nulls existing presence when its server is disabled via set-enabled-servers', () => {
		let state = stateWith(['server-1'])
		;[state] = UP.reducer(
			state,
			[clientOp({ code: 'update-activity', update: { code: 'enter-server-dashboard', serverId: 'server-1' } })],
			[],
		)
		expect(state.presence.get('client-1')?.activityState?.opts.serverId).toBe('server-1')
		;[state] = UP.reducer(state, [{ opId: 'disable', time: Date.now(), code: 'set-enabled-servers', serverIds: [] }], [])
		expect(state.presence.get('client-1')?.activityState).toBeNull()
		expect(state.enabledServers.size).toBe(0)
	})
})
