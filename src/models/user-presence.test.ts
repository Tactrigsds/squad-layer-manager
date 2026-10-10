import { describe, expect, it } from 'vitest'

import * as ODSM from '@/lib/odsm'

import * as UP from './user-presence'

describe('OpSchema', () => {
	const op = (activity: unknown) => ({
		opId: 'op',
		time: 1,
		clientId: 'client-1',
		userId: 1n,
		code: 'update-activity',
		update: { code: 'set-editing-queue', activity },
	})

	it('accepts a well-formed queue editing activity', () => {
		expect(UP.OpSchema.safeParse(op({ code: 'MOVING_ITEM', itemId: 'item-42' })).success).toBe(true)
	})

	it('rejects a queue editing activity missing its fields', () => {
		expect(UP.OpSchema.safeParse(op({ code: 'EDITING_ITEM' })).success).toBe(false)
		expect(UP.OpSchema.safeParse(op({ garbage: true })).success).toBe(false)
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
		expect(UP.activityServerId(next.presence.get('client-1')?.activityState)).toBe('server-1')
	})

	const editItem = (clientId: string, itemId: string, code: 'EDITING_ITEM' | 'MOVING_ITEM' = 'EDITING_ITEM'): UP.Op =>
		({
			...clientOp({
				code: 'update-activity',
				update: {
					code: 'set-editing-queue',
					activity: code === 'EDITING_ITEM' ? { code, itemId, cursor: { type: 'start' } } : { code, itemId },
				},
			}),
			clientId,
		}) as UP.Op

	it('ends editing (and drops locks) only for clients on the saved server', () => {
		const editQueue = (clientId: string, sid: string, itemId: string): UP.Op[] => [
			{ ...clientOp({ code: 'update-activity', update: { code: 'enter-server-dashboard', serverId: sid } }), clientId } as UP.Op,
			editItem(clientId, itemId),
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

	it('refuses an item another client holds, but not one the client holds itself', () => {
		const enter = (clientId: string) =>
			({ ...clientOp({ code: 'update-activity', update: { code: 'enter-server-dashboard', serverId: 'server-1' } }), clientId }) as UP.Op
		let state = stateWith(['server-1'])
		;[state] = UP.reducer(state, [enter('client-1'), enter('client-2'), editItem('client-1', 'item-1')], [])

		// a refused op changes nothing, so the batch is rejected as a no-op
		expect(() => UP.reducer(state, [editItem('client-2', 'item-1')], [])).toThrow(ODSM.RejectedError)

		;[state] = UP.reducer(state, [editItem('client-1', 'item-1', 'MOVING_ITEM')], [])
		expect(UP.editingQueue(state.presence.get('client-1')!.activityState)?.code).toBe('MOVING_ITEM')
		expect([...state.itemLocks]).toEqual([['item-1', 'client-1']])
	})

	it('nulls existing presence when its server is disabled via set-enabled-servers', () => {
		let state = stateWith(['server-1'])
		;[state] = UP.reducer(
			state,
			[clientOp({ code: 'update-activity', update: { code: 'enter-server-dashboard', serverId: 'server-1' } })],
			[],
		)
		expect(UP.activityServerId(state.presence.get('client-1')?.activityState)).toBe('server-1')
		;[state] = UP.reducer(state, [{ opId: 'disable', time: Date.now(), code: 'set-enabled-servers', serverIds: [] }], [])
		expect(state.presence.get('client-1')?.activityState).toBeNull()
		expect(state.enabledServers.size).toBe(0)
	})
})
