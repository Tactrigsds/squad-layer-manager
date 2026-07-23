import * as Paths from '$root/paths.ts'
import * as Arr from '@/lib/array'
import * as OneToMany from '@/lib/one-to-many-map.ts'
import type * as CS from '@/models/context-shared'
import { initModule } from '@/server/logger'

import type * as SM from '@/models/squad.models.ts'
import * as C from '@/server/context.ts'

import { withSftp } from '@/lib/sftp-file-store.ts'
import { Client as FTPClient } from 'basic-ftp'
import fs from 'fs'
import path from 'path'
import { WritableBuffer } from './writable-buffer'

const module = initModule('fetch-admin-lists')
let log!: CS.Logger

export function setup() {
	log = module.getLogger()
}

export default C.spanOp(
	'fetchAdminLists',
	{ module },
	async (sources: SM.AdminListSource[], adminIdentifyingPerms: SM.PlayerPerm[], signal?: AbortSignal): Promise<SM.AdminList> => {
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
			const sourceLabel = source.type === 'sftp' ? `${source.username}@${source.host}:${source.port}${source.filePath}` : source.source
			log.info(`Fetching admin list from ${source.type} source ${sourceLabel}`)
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
						const [host, port = 21] = hostPathString.substring(0, pathStartIndex === -1 ? hostPathString.length : pathStartIndex).split(
							':',
						)

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
				log.error(`Error fetching ${source.type} admin list: ${sourceLabel}`, error)
			}

			const groupRgx = /(?<=^Group=)(?<groupID>.*?):(?<groupPerms>.*?)(?=(?:\r\n|\r|\n|\s+\/\/))/gm
			const adminRgx = /(?<=^Admin=)(?<adminID>\d{17}|[a-f0-9]{32}):(?<groupID>\S+)/gm

			for (const m of data.matchAll(groupRgx)) {
				for (const perm of m.groups!.groupPerms.split(',')) {
					OneToMany.set(l.groups, m.groups!.groupID, perm)
				}
			}
			const steamId = /\d{17}/
			const eosId = /[a-f0-9]{32}/
			for (const m of data.matchAll(adminRgx)) {
				const id = m.groups!.adminID
				if (steamId.test(id)) {
					OneToMany.set(l.steam.players, id, m.groups!.groupID)
					l.steam.admins.add(id)
				} else if (eosId.test(id)) {
					OneToMany.set(l.eos.players, id, m.groups!.groupID)
				} else {
					throw new Error(`Invalid admin ID: ${id}`)
				}
			}
		}

		log.trace(`${Object.keys(l.steam.players).length + Object.keys(l.eos.players).length} ids loaded from adminlists...`)

		for (const idType of [l.eos, l.steam]) {
			for (const [steamId, group] of OneToMany.iter(idType.players)) {
				for (const [_, permission] of OneToMany.iter(l.groups, group)) {
					if (Arr.includes(adminIdentifyingPerms, permission)) idType.admins.add(steamId)
				}
			}
		}

		return l
	},
)
