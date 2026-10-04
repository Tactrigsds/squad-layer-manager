import { describe, expect, it } from 'vitest'

import * as PA from '@/models/procedure-access.models'
import * as RBAC from '@/rbac.models'

type Entries = typeof PA.PROCEDURE_ACCESS
type TakesInput = {
	[P in keyof Entries]: Entries[P] extends { req: (input: any) => any } | { before: (input: any) => any } ? P : never
}[keyof Entries]
type SampleInput<P extends TakesInput> = Entries[P] extends { req: (input: infer I) => any }
	? I
	: Entries[P] extends { before: (input: infer I) => any }
		? I
		: never

const S = { serverId: 's1' }

// an input for every entry that reads one, so a new entry has to be given one here
const SAMPLES: { [P in TakesInput]: SampleInput<P> } = {
	'squadServer.watchLayersStatus': S,
	'squadServer.watchServerRolling': S,
	'squadServer.watchTickRate': S,
	'squadServer.watchServerInfo': S,
	'squadServer.endMatch': S,
	'squadServer.watchChatEvents': S,
	'squadServer.toggleFogOfWar': S,
	'squadServer.getJoinLink': S,
	'squadServer.warnPlayers': S,
	'squadServer.warnAdmins': S,
	'squadServer.broadcast': S,
	'squadServer.demoteCommander': S,
	'squadServer.disbandSquad': S,
	'squadServer.removeFromSquad': S,
	'squadServer.removePlayersFromSquad': S,
	'squadServer.kill': S,
	'squadServer.kickPlayers': S,
	'squadServer.renameSquad': S,
	'layerQueue.watchNextLayerSyncState': S,
	'layerQueue.watchIngameVote': S,
	'layerQueue.toggleUpdatesToSquadServer': S,
	'layerQueue.enableIngameVoting': S,
	'layerQueue.watchOps': S,
	'layerQueue.dispatchOp': S,
	'vote.startVote': S,
	'vote.endVoteEarly': S,
	'vote.abortVote': S,
	'vote.cancelVoteAutostart': S,
	'vote.watchUpdates': S,
	'settings.server.watchSettings': S,
	'settings.server.updateSettings': { ...S, ops: [{ path: ['queue', 'mainPool'] }, { path: ['connections', 'rcon', 'host'] }] },
	'settings.admin.createServer': { id: 's2' },
	'settings.admin.getRawSettings': S,
	'matchHistory.watchMatchHistoryState': S,
	'matchHistory.getMatchEvents': S,
	'matchHistory.getPopulation': S,
	'matchHistory.getPlayerDetails': S,
	'matchHistory.getSquadDetails': S,
	'filters.updateFilter': ['f1'],
	'filters.deleteFilter': 'f1',
	'filters.changeFilterOwner': { filterId: 'f1' },
	'filterEdit.dispatchOps': { filterId: 'f1' },
	'teamswaps.watchUpdates': S,
	'teamswaps.dispatchOp': S,
	'switchRequests.watchUpdates': S,
	'switchRequests.switchNow': S,
	'plugins.rpcStream': S,
	'plugins.rpcCall': S,
	'timeouts.timeoutPlayer': { ...S, durationMs: 60_000 },
	'sandbox.watchState': S,
	'sandbox.execute': S,
	'serverConsole.watch': S,
}

// every permission there is, unrestricted: what a super user holds
const EVERYTHING: RBAC.Permission[] = [
	...RBAC.ROLE_GRANTABLE_PERMISSION_TYPE.options.map((type) =>
		RBAC.perm(type as 'site:authorized', RBAC.unrestrictedRoleGrantArgs(type) as undefined),
	),
	RBAC.perm('squad-server:timeout-players', { serverId: null, maxDurationMs: null }),
	RBAC.perm('queue:request-layers', { serverId: null, maxQueued: null }),
	RBAC.pluginAction(RBAC.ANY_PLUGIN_ACTION, RBAC.ANY_PLUGIN_ACTION),
]

function checkedUpFront() {
	return Object.entries(PA.PROCEDURE_ACCESS).flatMap(([path, access]) => {
		const req = RBAC.Access.resolve(access as RBAC.Access<unknown>, (SAMPLES as Record<string, unknown>)[path])
		return req ? [[path, req] as const] : []
	})
}

describe('PROCEDURE_ACCESS', () => {
	it('refuses a user holding nothing wherever it checks anything', () => {
		const admitted = checkedUpFront().filter(([, req]) => !RBAC.tryDenyPermissions([], req, RBAC.NO_SCOPED_SERVERS))
		expect(admitted.map(([path]) => path)).toEqual([])
	})

	it('admits a user holding everything, so no entry asks for something nobody can hold', () => {
		const refused = checkedUpFront().filter(([, req]) => RBAC.tryDenyPermissions(EVERYTHING, req, RBAC.NO_SCOPED_SERVERS))
		expect(refused.map(([path]) => path)).toEqual([])
	})

	it('names the unmet grant rather than the procedure', () => {
		const req = RBAC.Access.resolve(PA.PROCEDURE_ACCESS['squadServer.endMatch'], S)!
		expect(RBAC.tryDenyPermissions([RBAC.perm('squad-server:view', S)], req, RBAC.NO_SCOPED_SERVERS)).toEqual({
			code: 'err:permission-denied',
			checkType: 'all',
			failures: ['squad-server:end-match'],
		})
	})
})
