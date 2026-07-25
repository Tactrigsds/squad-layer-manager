import { Client as FTPClient } from 'basic-ftp'
import fs from 'fs'
import path from 'path'
import * as Rx from 'rxjs'

import * as Paths from '$root/paths.ts'
import * as Arr from '@/lib/array'
import { AsyncResource } from '@/lib/async-resource.ts'
import { isolateContext, IsolatedBehaviorSubject } from '@/lib/isolated-subject'
import * as OneToMany from '@/lib/one-to-many-map.ts'
import { WritableBuffer } from '@/lib/rcon/writable-buffer'
import { withSftp } from '@/lib/sftp-file-store.ts'
import { HumanTime } from '@/lib/zod'
import * as CS from '@/models/context-shared'
import type * as SM from '@/models/squad.models.ts'
import * as C from '@/server/context.ts'
import { initModule } from '@/server/logger'
import * as CleanupSys from '@/systems/cleanup.server'
import * as Settings from '@/systems/settings.server'

const module = initModule('fetch-admin-lists')
let log!: CS.Logger

export type AdminListStatus =
	| {
			code: 'init'
	  }
	| {
			code: 'ok'
	  }
	| {
			code: 'error'
			message: string
	  }

// One resource per named list, rather than one merged list for the install. Merging was what made "admin" a global
// fact: two sources with different conventions for marking an admin ended up granting each other's, and a server had
// no way to recognise some lists and not others.
//
// Resources are created on demand and outlive settings edits (the fetch reads GLOBAL_SETTINGS fresh), so a rename
// leaves an orphan that `pruneRemoved` drops rather than a stale list anyone can still reach.
const resources = new Map<SM.AdminListId, AsyncResource<SM.AdminList, CS.Ctx & CS.AbortSignal>>()

export let status$: IsolatedBehaviorSubject<AdminListStatus>

const ADMIN_LIST_TTL = HumanTime.parse('1h')

function resourceFor(listId: SM.AdminListId): AsyncResource<SM.AdminList, CS.Ctx & CS.AbortSignal> {
	const existing = resources.get(listId)
	if (existing) return existing
	const resource = new AsyncResource<SM.AdminList, CS.Ctx & CS.AbortSignal>(
		`adminList:${listId}`,
		async (_ctx) => {
			// read fresh rather than closing over setup-time settings, so an edit is picked up by invalidation alone
			const def = Settings.GLOBAL_SETTINGS.adminLists[listId]
			if (!def) throw new Error(`admin list '${listId}' is no longer configured`)
			const res = await fetchAdminList(listId, def, _ctx.signal)
			status$.next({ code: 'ok' })
			return res
		},
		module,
		{
			defaultTTL: ADMIN_LIST_TTL,
			retries: 3,
			retryDelay: 1000,
			log,
			onFatalError: (err) => {
				status$.next({ code: 'error', message: err instanceof Error ? err.message : String(err) })
			},
		},
	)
	resources.set(listId, resource)
	return resource
}

// A list SLM synthesises for a server rather than fetching, keyed by server. The sandbox registers one so an
// emulated server has admins without an operator configuring a source for something that only exists in memory.
// Deliberately not a configured source: there is nothing to point a source at.
export const IMPLICIT_LIST_ID = 'Emulated'
const implicitLists = new Map<string, () => SM.AdminList>()

export function registerImplicitList(serverId: string, provider: () => SM.AdminList) {
	implicitLists.set(serverId, provider)
}

export function unregisterImplicitList(serverId: string) {
	implicitLists.delete(serverId)
}

export function hasImplicitList(serverId: string): boolean {
	return implicitLists.has(serverId)
}

// Every list that speaks for a server: the ones it names, plus its implicit one if it has one.
export async function getListsForServerId(ctx: CS.Ctx & CS.AbortSignal, serverId: string, opts?: { ttl?: number }): Promise<SM.AdminLists> {
	const lists = await getListsForServer(ctx, listIdsForServer(serverId), opts)
	const implicit = implicitLists.get(serverId)
	if (implicit) lists.set(IMPLICIT_LIST_ID, implicit())
	return lists
}

// Every configured list, for the web-user path: a user is on no server, so there is no server to scope to.
export async function getAllLists(ctx: CS.Ctx & CS.AbortSignal): Promise<SM.AdminLists> {
	return await getListsForServer(ctx, configuredListIds())
}

// The lists a server recognises. Read from the in-memory registry rather than the db: this is asked on every roster
// poll and every in-game permission check. Lives here rather than in rbac.server, which cannot import settings.server
// (that already imports rbac.server).
export function listIdsForServer(serverId: string): readonly SM.AdminListId[] {
	return Settings.getServerEntry(serverId)?.adminLists ?? []
}

export function configuredListIds(): SM.AdminListId[] {
	return Object.keys(Settings.GLOBAL_SETTINGS.adminLists)
}

// a list that stopped being configured must stop being reachable, or a role assignment naming it would keep resolving
// against whatever it last fetched
export function pruneRemoved() {
	const configured = new Set(configuredListIds())
	for (const [listId, resource] of [...resources]) {
		if (configured.has(listId)) continue
		resources.delete(listId)
		resource.dispose()
	}
}

export function invalidateAll(ctx: CS.Ctx & CS.AbortSignal) {
	pruneRemoved()
	for (const resource of resources.values()) resource.invalidate(ctx)
}

// One list. Returns null rather than throwing when the name is not configured: a server or role assignment naming a
// deleted list is a configuration mistake to survive, not a reason to deny every permission check on that server.
export async function getList(ctx: CS.Ctx & CS.AbortSignal, listId: SM.AdminListId, opts?: { ttl?: number }): Promise<SM.AdminList | null> {
	if (!Settings.GLOBAL_SETTINGS.adminLists[listId]) return null
	try {
		return await resourceFor(listId).get(ctx, opts)
	} catch (err) {
		log.warn(err, `Could not read admin list '${listId}'`)
		return null
	}
}

// The lists a server recognises, which is the set every per-player question about that server is answered against.
export async function getListsForServer(
	ctx: CS.Ctx & CS.AbortSignal,
	listIds: readonly SM.AdminListId[],
	opts?: { ttl?: number },
): Promise<SM.AdminLists> {
	const entries = await Promise.all(listIds.map(async (listId) => [listId, await getList(ctx, listId, opts)] as const))
	const lists: SM.AdminLists = new Map()
	for (const [listId, list] of entries) {
		if (list) lists.set(listId, list)
	}
	return lists
}

// The lists a server uses, flattened into one. For the many consumers that only ask "is this player an admin here"
// or "what groups do they hold here" -- questions the merged view answers exactly. Each list has already applied its
// own admin-identifying permissions by this point, so the admin sets union rather than being recomputed, and no list
// can widen another's definition of admin.
export async function getMergedForServer(ctx: CS.Ctx & CS.AbortSignal, serverId: string, opts?: { ttl?: number }): Promise<SM.AdminList> {
	const lists = await getListsForServerId(ctx, serverId, opts)
	const merged: SM.AdminList = {
		groups: new Map(),
		steam: { players: new Map(), admins: new Set() },
		eos: { players: new Map(), admins: new Set() },
	}
	for (const list of lists.values()) {
		for (const [group, perm] of OneToMany.iter(list.groups)) OneToMany.set(merged.groups, group, perm)
		for (const side of ['steam', 'eos'] as const) {
			for (const [id, group] of OneToMany.iter(list[side].players)) OneToMany.set(merged[side].players, id, group)
			for (const id of list[side].admins) merged[side].admins.add(id as never)
		}
	}
	return merged
}

export function setup() {
	log = module.getLogger()
	status$ = new IsolatedBehaviorSubject<AdminListStatus>({ code: 'init' })
	CleanupSys.register(() => {
		for (const resource of resources.values()) resource.dispose()
		resources.clear()
	}, status$)
}

// emits when any list's (re)fetch produces admin data different from the last, so rbac can flush admin-derived roles.
// Gated on a content fingerprint per list, so an unchanged TTL refresh is a no-op and an initial load never fires.
// isolateContext keeps a subscriber's work out of the fetch's async context. Subscribing registers a long-lived
// observer, so lists also refetch proactively at their TTL (wire only after settings load: the fetch reads
// GLOBAL_SETTINGS).
export const changed$: Rx.Observable<void> = Rx.defer(() =>
	Rx.merge(
		...configuredListIds().map((listId) =>
			resourceFor(listId)
				.observe({ ...CS.init(), signal: CleanupSys.shutdownSignal })
				.pipe(
					Rx.map((l) => `${listId}:${fingerprint(l)}`),
					Rx.distinctUntilChanged(),
					Rx.skip(1),
				),
		),
	),
).pipe(
	isolateContext(),
	Rx.map(() => undefined),
	Rx.share(),
)

// stable string over the parts that drive rbac (group perms, per-id groups, admin sets); admin lists are small
function fingerprint(l: SM.AdminList): string {
	const idPart = (t: SM.AdminList['eos']) => {
		const players = [...OneToMany.iter(t.players)]
			.map(([id, g]) => `${id}=${g}`)
			.sort()
			.join(',')
		const admins = [...t.admins].sort().join(',')
		return `${players}#${admins}`
	}
	const groups = [...OneToMany.iter(l.groups)]
		.map(([g, p]) => `${g}=${p}`)
		.sort()
		.join(',')
	return `${groups}||${idPart(l.eos)}||${idPart(l.steam)}`
}

const GROUP_RGX = /(?<=^Group=)(?<groupID>.*?):(?<groupPerms>.*?)(?=(?:\r\n|\r|\n|\s+\/\/))/gm
const ADMIN_RGX = /(?<=^Admin=)(?<adminID>\d{17}|[a-f0-9]{32}):(?<groupID>\S+)/gm

function parseAdminsCfgInto(l: SM.AdminList, data: string) {
	for (const m of data.matchAll(GROUP_RGX)) {
		for (const perm of m.groups!.groupPerms.split(',')) {
			OneToMany.set(l.groups, m.groups!.groupID, perm)
		}
	}
	const steamId = /\d{17}/
	const eosId = /[a-f0-9]{32}/
	for (const m of data.matchAll(ADMIN_RGX)) {
		const id = m.groups!.adminID
		if (steamId.test(id)) {
			OneToMany.set(l.steam.players, id, m.groups!.groupID)
		} else if (eosId.test(id)) {
			OneToMany.set(l.eos.players, id, m.groups!.groupID)
		} else {
			throw new Error(`Invalid admin ID: ${id}`)
		}
	}
}

function markAdmins(l: SM.AdminList, identifyingPerms: readonly string[]) {
	for (const idType of [l.eos, l.steam]) {
		for (const [id, group] of OneToMany.iter(idType.players)) {
			for (const [_, permission] of OneToMany.iter(l.groups, group)) {
				if (Arr.includes(identifyingPerms as SM.PlayerPerm[], permission)) idType.admins.add(id as never)
			}
		}
	}
}

// An Admins.cfg the app holds in memory rather than fetching, parsed by exactly the path a fetched one takes so an
// emulated list cannot behave differently from a real one.
export function parseAdminsCfg(data: string, identifyingPerms: readonly string[]): SM.AdminList {
	const l: SM.AdminList = {
		groups: new Map(),
		steam: { players: new Map(), admins: new Set() },
		eos: { players: new Map(), admins: new Set() },
	}
	parseAdminsCfgInto(l, data)
	markAdmins(l, identifyingPerms)
	return l
}

const fetchAdminList = C.spanOp(
	'fetchAdminList',
	{ module },
	async (listId: SM.AdminListId, def: SM.AdminListDef, signal?: AbortSignal): Promise<SM.AdminList> => {
		const sources = [def.source]
		const adminIdentifyingPerms = def.adminIdentifyingPermissions
		const l: SM.AdminList = {
			groups: new Map(),
			steam: {
				players: new Map(),
				admins: new Set(),
			},
			eos: {
				players: new Map(),
				admins: new Set(),
			},
		}

		for (const [_idx, source] of sources.entries()) {
			const sourceLabel =
				source.type === 'sftp' ? `${source.username}@${source.host}:${source.port}${source.filePath}` : source.source
			log.info(`Fetching admin list '${listId}' from ${source.type} source ${sourceLabel}`)
			let data = ''
			try {
				switch (source.type) {
					case 'remote': {
						const resp = await fetch(source.source, { signal })
						data = await resp.text()
						break
					}
					case 'local': {
						const listPath = path.resolve(Paths.PROJECT_ROOT, source.source)
						if (!fs.existsSync(listPath)) {
							throw new Error(`Could not find Admin List at ${listPath}`)
						}
						data = fs.readFileSync(listPath, 'utf8')
						break
					}
					case 'ftp': {
						// ex url: ftp//<user>:<password>@<host>:<port>/<url-path>
						if (!source.source.startsWith('ftp://')) {
							throw new Error(
								`Invalid FTP URI format of ${source.source}. The source must be a FTP URI starting with the protocol. Ex: ftp://username:password@host:21/some/file.txt`,
							)
						}
						const [loginString, hostPathString] = source.source.substring('ftp://'.length).split('@')
						const [user, password] = loginString.split(':').map((v) => decodeURI(v))
						const pathStartIndex = hostPathString.indexOf('/')
						const remoteFilePath = pathStartIndex === -1 ? '/' : hostPathString.substring(pathStartIndex)
						const [host, port = 21] = hostPathString
							.substring(0, pathStartIndex === -1 ? hostPathString.length : pathStartIndex)
							.split(':')

						const buffer = new WritableBuffer()
						const ftpClient = new FTPClient()
						await ftpClient.access({
							host,
							port: port as number,
							user,
							password,
						})
						await ftpClient.downloadTo(buffer, remoteFilePath)
						data = buffer.toString('utf8')
						break
					}
					case 'sftp': {
						const buffer = await withSftp(
							{ host: source.host, port: source.port, username: source.username, password: source.password },
							(session) => session.readFile(source.filePath),
							signal,
						)
						data = buffer.toString('utf8')
						break
					}
					default: {
						const _exhaustive: never = source
						throw new Error(`Unsupported AdminList type`)
					}
				}
			} catch (error) {
				if (signal?.aborted) throw signal.reason
				log.error(error, `Error fetching ${source.type} admin list '${listId}': ${sourceLabel}`)
			}

			parseAdminsCfgInto(l, data)
		}

		log.trace(`${Object.keys(l.steam.players).length + Object.keys(l.eos.players).length} ids loaded from admin list '${listId}'`)

		markAdmins(l, adminIdentifyingPerms)

		return l
	},
)
