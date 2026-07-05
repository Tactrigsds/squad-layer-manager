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
