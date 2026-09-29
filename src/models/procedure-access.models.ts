// What every oRPC procedure requires, keyed by its router path. The server's base middleware evaluates the entry
// before the handler runs, and the client evaluates the same entry to decide whether to offer the action at all, so a
// button and the call behind it cannot drift apart. Adding a procedure without an entry is a type error.
//
// Entries take the procedure's parsed input, narrowed to the fields they read. That narrowed type is also what a
// client passes to check access ahead of the call.

import type { AnyProcedure, InferSchemaOutput, Procedure, Schema } from '@orpc/server'

import * as SETTINGS from '@/models/settings.models'
import * as SM from '@/models/squad.models'
import * as RBAC from '@/rbac.models'
import type { OrpcAppRouter } from '@/server/orpc-app-router'

const { Access, Req } = RBAC

type ServerInput = { serverId: string }

const VIEW_SERVER = Access.req((i: ServerInput) => Req.viewServer(i.serverId))

function onServer(type: RBAC.ServerPermissionType) {
	return Access.req((i: ServerInput) => Req.perm(type, { serverId: i.serverId }))
}

function global(type: RBAC.GlobalPermissionType) {
	return Access.req(Req.perm(type as 'site:authorized'))
}

const GLOBAL_SETTINGS_READ = Access.req(SETTINGS.Grants.globalSettingsRead())

// live player identity and standing, as the dashboard shows it or as the history page resolves it
const PLAYER_LOOKUP = Access.req(Req.any(Req.perm('history:query'), Req.viewAnyServer()))

export const PROCEDURE_ACCESS = {
	'battlemetrics.getPlayerBmData': PLAYER_LOOKUP,
	'battlemetrics.refreshPlayerBmData': Access.req(Req.viewAnyServer()),
	'battlemetrics.watchPlayerBmData': Access.req(Req.viewAnyServer()),
	'battlemetrics.listOrgFlags': Access.PUBLIC,
	'battlemetrics.updateFlags': global('battlemetrics:write-flags'),
	'battlemetrics.addFlags': global('battlemetrics:write-flags'),

	'squadServer.listAdminListGroups': GLOBAL_SETTINGS_READ,
	'squadServer.watchLoadedServers': Access.FILTERED,
	'squadServer.watchLayersStatus': VIEW_SERVER,
	'squadServer.watchServerRolling': VIEW_SERVER,
	'squadServer.watchTickRate': VIEW_SERVER,
	'squadServer.watchServerInfo': VIEW_SERVER,
	'squadServer.endMatch': onServer('squad-server:end-match'),
	'squadServer.watchChatEvents': VIEW_SERVER,
	'squadServer.toggleFogOfWar': onServer('squad-server:turn-fog-off'),
	'squadServer.getJoinLink': VIEW_SERVER,
	'squadServer.warnPlayers': onServer('squad-server:warn-players'),
	'squadServer.warnAdmins': onServer('squad-server:warn-players'),
	'squadServer.broadcast': onServer('squad-server:broadcast'),
	'squadServer.demoteCommander': onServer('squad-server:manage-players'),
	'squadServer.disbandSquad': onServer('squad-server:manage-players'),
	'squadServer.removeFromSquad': onServer('squad-server:manage-players'),
	'squadServer.removePlayersFromSquad': onServer('squad-server:manage-players'),
	'squadServer.kill': onServer('squad-server:manage-players'),
	'squadServer.kickPlayers': onServer('squad-server:kick-players'),
	'squadServer.renameSquad': onServer('squad-server:manage-players'),

	'layerQueue.watchNextLayerSyncState': VIEW_SERVER,
	'layerQueue.watchIngameVote': VIEW_SERVER,
	'layerQueue.toggleUpdatesToSquadServer': onServer('squad-server:disable-slm-updates'),
	'layerQueue.enableIngameVoting': onServer('squad-server:disable-slm-updates'),
	'layerQueue.watchOps': VIEW_SERVER,
	'layerQueue.dispatchOp': Access.inHandler(
		'what an op requires depends on the op, the queue it lands on and who owns the items it touches',
		(i: ServerInput) => Req.viewServer(i.serverId),
	),

	'vote.startVote': onServer('vote:manage'),
	'vote.endVoteEarly': onServer('vote:manage'),
	'vote.abortVote': onServer('vote:manage'),
	'vote.cancelVoteAutostart': onServer('vote:manage'),
	'vote.watchUpdates': VIEW_SERVER,

	'config.watchConfig': Access.PUBLIC,
	'announcements.watch': Access.PUBLIC,

	'settings.public.watchPublicSettings': Access.FILTERED,
	'settings.global.watchSettings': GLOBAL_SETTINGS_READ,
	'settings.global.updateSettings': Access.inHandler(
		'the paths it writes are the diff against the current settings',
		Req.holdsAnyGrant('global-settings:write'),
	),
	'settings.global.upsertLayerTag': global('queue:manage-tags'),
	'settings.server.watchSettings': VIEW_SERVER,
	'settings.server.updateSettings': Access.req((i: ServerInput & { ops: { path: (string | number)[] }[] }) =>
		SETTINGS.Grants.writeServerSettingsPaths(
			i.serverId,
			i.ops.map((op) => op.path),
		),
	),
	'settings.admin.enableServer': global('admin:manage-servers'),
	'settings.admin.disableServer': global('admin:manage-servers'),
	// supplying a server's connection details is gated by write-sensitive, so creating one needs it for the new id
	'settings.admin.createServer': Access.req((i: { id: string }) =>
		Req.all(Req.perm('admin:manage-servers'), Req.perm('server-settings:write-sensitive', { serverId: i.id })),
	),
	'settings.admin.deleteServer': global('admin:delete-servers'),
	'settings.admin.setDefaultServer': global('admin:manage-servers'),
	'settings.admin.getRawSettings': Access.req((i: ServerInput) => Req.perm('server-settings:read', { serverId: i.serverId })),
	'settings.admin.updateRawSettings': Access.inHandler('the paths it writes are the diff against the stored settings'),

	'layerQueries.getLayerInfo': Access.PUBLIC,

	'userPresence.watchUpdates': Access.PUBLIC,
	'userPresence.dispatchOp': Access.SELF,

	'discord.getGuildEmojis': Access.PUBLIC,

	'matchHistory.watchMatchHistoryState': VIEW_SERVER,
	'matchHistory.getMatchEvents': VIEW_SERVER,
	'matchHistory.getPlayerDetails': VIEW_SERVER,
	'matchHistory.getSquadDetails': VIEW_SERVER,

	'history.query': global('history:query'),
	'history.selectionText': global('history:query'),
	'history.playerInfo': PLAYER_LOOKUP,
	'history.searchPlayers': global('history:query'),
	'history.listUsers': global('history:query'),
	'history.playerLabels': global('history:query'),
	'history.listSaved': global('history:query'),
	'history.save': global('history:query'),
	'history.deleteSaved': global('history:query'),

	'filters.getFilterContributors': Access.PUBLIC,
	'filters.getAllFilterRoleContributors': Access.PUBLIC,
	'filters.addFilterContributor': Access.inHandler('needs the filter row to know its owner'),
	'filters.removeFilterContributor': Access.inHandler('needs the filter row to know its owner'),
	'filters.createFilter': global('filters:create'),
	'filters.updateFilter': Access.req((i: [id: string, ...unknown[]]) => RBAC.getWritePermReqForFilterEntity(i[0])),
	'filters.deleteFilter': Access.req((id: string) => RBAC.getWritePermReqForFilterEntity(id)),
	'filters.watchFilters': Access.PUBLIC,
	'filters.watchFilterReferences': Access.PUBLIC,
	'filters.changeFilterOwner': Access.req((i: { filterId: string }) => RBAC.getManagePermReqForFilterEntity(i.filterId)),

	'filterEdit.watchUpdates': Access.PUBLIC,
	'filterEdit.dispatchOps': Access.req((i: { filterId: string }) => RBAC.getWritePermReqForFilterEntity(i.filterId)),

	'rbac.getUserDefinedRoles': Access.PUBLIC,
	'rbac.getMyRoles': Access.SELF,
	'rbac.getSimulatableRoles': Access.FILTERED,
	'rbac.getSuperConfig': GLOBAL_SETTINGS_READ,
	'rbac.listGuildRoles': GLOBAL_SETTINGS_READ,
	'rbac.searchGuildMembers': GLOBAL_SETTINGS_READ,
	// the channel picker also renders in a plugin's config, which an admin who can only manage plugins has to fill in
	'rbac.listGuildChannels': Access.req(Req.any(SETTINGS.Grants.globalSettingsRead(), Req.perm('plugins:manage'))),
	'rbac.listAdminListGroups': GLOBAL_SETTINGS_READ,

	'users.getLoggedInUser': Access.SELF,
	'users.getUser': Access.PUBLIC,
	'users.getUsers': Access.PUBLIC,
	'users.getMyLinkedSteamAccounts': Access.SELF,
	'users.beginSteamLinkVerification': Access.SELF,
	'users.updateLinkedSteamAccounts': Access.SELF,
	'users.getSteamAccountLink': global('users:manage-steam-links'),
	'users.assignSteamLink': Access.inHandler(
		'the link must not grant anything the caller does not hold, which depends on what the subject already holds',
		Req.perm('users:manage-steam-links'),
	),
	'users.removeSteamLink': Access.inHandler(
		'the unlink must not take away anything the caller does not hold, which depends on what the subject holds',
		Req.perm('users:manage-steam-links'),
	),
	'users.updateNickname': Access.SELF,
	'users.watchUserInvalidation': Access.SELF,

	'teamswaps.watchUpdates': VIEW_SERVER,
	'teamswaps.dispatchOp': onServer('squad-server:manage-players'),

	'switchRequests.watchUpdates': VIEW_SERVER,
	'switchRequests.switchNow': onServer('squad-server:manage-players'),

	'appEvents.list': GLOBAL_SETTINGS_READ,

	'plugins.watchPlugins': Access.PUBLIC,
	'plugins.getSettings': global('plugins:manage'),
	'plugins.setEnabled': global('plugins:manage'),
	'plugins.updateSettings': global('plugins:manage'),
	'plugins.rpcStream': Access.inHandler("the plugin procedure's own access declaration", (i: ServerInput) => Req.viewServer(i.serverId)),
	'plugins.installFromUrl': global('plugins:manage'),
	'plugins.refresh': global('plugins:manage'),
	'plugins.rescan': global('plugins:manage'),
	'plugins.purgeData': global('plugins:manage'),
	'plugins.uninstall': global('plugins:manage'),
	'plugins.rpcCall': Access.inHandler("the plugin procedure's own access declaration", (i: ServerInput) => Req.viewServer(i.serverId)),

	'timeouts.listActiveTimeouts': Access.FILTERED,
	'timeouts.watchActiveTimeouts': Access.FILTERED,
	'timeouts.cancelTimeout': Access.inHandler('needs the timeout row to know which server issued it'),
	// a timeout grant is not server-scoped, so it does not imply view on its own
	'timeouts.timeoutPlayer': Access.req((i: ServerInput & { durationMs: number }) =>
		Req.all(Req.viewServer(i.serverId), SM.Grants.satisfyingTimeout(i.serverId, i.durationMs)),
	),

	'sandbox.listSandboxServers': Access.FILTERED,
	'sandbox.watchState': onServer('sandbox:control'),
	'sandbox.execute': onServer('sandbox:control'),
	'sandbox.listVerbs': Access.PUBLIC,

	'serverConsole.watch': onServer('squad-server:view-console'),

	'tutorials.list': Access.PUBLIC,
	'tutorials.getDismissedPrompts': Access.SELF,
	'tutorials.dismissPrompt': Access.SELF,
	'tutorials.getProgress': Access.SELF,
	'tutorials.saveProgress': Access.SELF,
	'tutorials.watchRun': Access.SELF,
	'tutorials.start': Access.SELF,
	'tutorials.stage': Access.SELF,
	'tutorials.abandon': Access.SELF,
} satisfies { [P in ProcedurePath]: RBAC.Access<ProcedureInput<P>> }

// ---------------------------------------------------------------- types ----------------------------------------------------------------

type ProcedurePaths<R, Prefix extends string = ''> = {
	[K in keyof R & string]: R[K] extends AnyProcedure ? `${Prefix}${K}` : ProcedurePaths<R[K], `${Prefix}${K}.`>
}[keyof R & string]

export type ProcedurePath = ProcedurePaths<OrpcAppRouter>

type ProcedureAt<R, P extends string> = P extends `${infer Head}.${infer Tail}`
	? Head extends keyof R
		? ProcedureAt<R[Head], Tail>
		: never
	: P extends keyof R
		? R[P]
		: never

// the input after validation, which is what the middleware sees
export type ProcedureInput<P extends ProcedurePath> =
	ProcedureAt<OrpcAppRouter, P> extends Procedure<any, any, infer I, any, any, any> ? InferSchemaOutput<I> : never

type Entries = typeof PROCEDURE_ACCESS

// the procedures whose access is decided up front, which is what a client can check ahead of a call
export type CheckablePath = { [P in keyof Entries]: Entries[P] extends { kind: 'req' } ? P : never }[keyof Entries]

// what a client passes to check a procedure's access: only the fields its entry reads
export type AccessInput<P extends CheckablePath> = Entries[P] extends { req: infer R }
	? R extends (input: infer I) => any
		? I
		: void
	: never

export function getAccess(path: string): RBAC.Access<unknown> | undefined {
	return (PROCEDURE_ACCESS as Record<string, RBAC.Access<unknown>>)[path]
}

// what a procedure checked up front requires, given the fields its entry reads
export function checkedReq<P extends CheckablePath>(path: P, input: AccessInput<P>): RBAC.Req {
	return RBAC.Access.resolve(PROCEDURE_ACCESS[path] as RBAC.Access<AccessInput<P>>, input)!
}

// A procedure whose access the middleware checks can answer with a denial instead of its own output, which its
// handler's type does not say. This widens each such procedure's output for the client to include it: a plain call
// can return one, and a stream can yield one.
type WithDenial<O> =
	O extends AsyncGenerator<infer T, infer TReturn, infer TNext>
		? AsyncGenerator<T | RBAC.PermissionDeniedResponse, TReturn, TNext>
		: O | RBAC.PermissionDeniedResponse

type Deniable<P> =
	P extends Procedure<infer TInitial, infer TCurrent, infer TInput, infer TOutput, infer TErrors, infer TMeta>
		? Procedure<
				TInitial,
				TCurrent,
				TInput,
				Schema<WithDenial<InferSchemaOutput<TOutput>>, WithDenial<InferSchemaOutput<TOutput>>>,
				TErrors,
				TMeta
			>
		: never

type DeniableRouter<R, Prefix extends string = ''> = {
	[K in keyof R]: K extends string
		? R[K] extends AnyProcedure
			? `${Prefix}${K}` extends keyof Entries
				? Entries[`${Prefix}${K}`] extends { kind: 'none' }
					? R[K]
					: Deniable<R[K]>
				: R[K]
			: DeniableRouter<R[K], `${Prefix}${K}.`>
		: R[K]
}

// A router whose every procedure may answer with a denial: a plugin's, whose access is declared in meta its type
// does not carry
export type AllDeniable<R> = { [K in keyof R]: R[K] extends AnyProcedure ? Deniable<R[K]> : AllDeniable<R[K]> }

// the router's type as a client sees it
export type ClientRouter = DeniableRouter<OrpcAppRouter>
