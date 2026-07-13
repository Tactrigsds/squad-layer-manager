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

	it('round-trips editing the queue and teamswaps simultaneously', () => {
		let activity = UP.applyActivityUpdate(null, { code: 'enter-server-dashboard', serverId })
		activity = UP.applyActivityUpdate(activity, {
			code: 'set-editing-queue',
			variant: ST.Match.leaf('IDLE', {}) as UP.QueueEditingActivity<'IDLE'>,
		})
		activity = UP.applyActivityUpdate(activity, { code: 'set-editing-teamswaps' })
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

	it('ends editing (and drops locks) only for clients on the saved server', () => {
		const editQueue = (clientId: string, sid: string, itemId: string): UP.Op[] => [
			{ ...clientOp({ code: 'update-activity', update: { code: 'enter-server-dashboard', serverId: sid } }), clientId } as UP.Op,
			{
				...clientOp({
					code: 'update-activity',
					update: {
						code: 'set-editing-queue',
						variant: ST.Match.leaf('EDITING_ITEM', { itemId, cursor: { type: 'start' } }) as UP.QueueEditingActivity,
					},
				}),
				clientId,
			} as UP.Op,
		]

		let state = stateWith(['server-1', 'server-2'])
		;[state] = UP.reducer(state, [...editQueue('client-1', 'server-1', 'item-1'), ...editQueue('client-2', 'server-2', 'item-2')], [])
		expect(state.itemLocks.size).toBe(2)
		;[state] = UP.reducer(state, [{ opId: 'end', time: Date.now(), code: 'sll:end-all-editing', serverId: 'server-1' }], [])

		expect(UP.Trans.editingQueue('server-1').match(state.presence.get('client-1')!.activityState!)).toBeFalsy()
		expect(UP.Trans.editingQueue('server-2').match(state.presence.get('client-2')!.activityState!)).toBeTruthy()
		expect([...state.itemLocks.keys()]).toEqual(['item-2'])
	})

	it('ends teamswap editing only for clients on the saved server', () => {
		const editTeamswaps = (clientId: string, sid: string): UP.Op[] => [
			{ ...clientOp({ code: 'update-activity', update: { code: 'enter-server-dashboard', serverId: sid } }), clientId } as UP.Op,
			{ ...clientOp({ code: 'update-activity', update: { code: 'set-editing-teamswaps' } }), clientId } as UP.Op,
		]

		let state = stateWith(['server-1', 'server-2'])
		;[state] = UP.reducer(state, [...editTeamswaps('client-1', 'server-1'), ...editTeamswaps('client-2', 'server-2')], [])
		;[state] = UP.reducer(state, [{ opId: 'end', time: Date.now(), code: 'teamswaps:end-all-editing', serverId: 'server-1' }], [])

		expect(UP.Trans.editingTeamswaps('server-1').match(state.presence.get('client-1')!.activityState!)).toBeFalsy()
		expect(UP.Trans.editingTeamswaps('server-2').match(state.presence.get('client-2')!.activityState!)).toBeTruthy()
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
