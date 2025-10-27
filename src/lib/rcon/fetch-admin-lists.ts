import * as Paths from '$root/paths.ts'
import * as OneToMany from '@/lib/one-to-many-map.ts'
import { OneToManyMap } from '@/lib/one-to-many-map.ts'
import * as CS from '@/models/context-shared'
import * as SM from '@/models/squad.models.ts'
import * as C from '@/server/context.ts'
import * as Otel from '@opentelemetry/api'
import { Client as FTPClient } from 'basic-ftp'
import fs from 'fs'
import path from 'path'

import WritableBuffer from './writable-buffer.ts'

const tracer = Otel.trace.getTracer('fetch-admin-lists')
export default C.spanOp('fetch-admin-lists', { tracer }, async (ctx: CS.Log, sources: SM.AdminListSource[]): Promise<SM.AdminList> => {
	// maps groups to their permissions
	const groups: OneToManyMap<string, string> = new Map()

	// maps admins to their groups
	const admins: OneToManyMap<bigint, string> = new Map()

	for (const [_idx, source] of sources.entries()) {
		ctx.log.info(`Fetching admin list from ${source.type} source ${source.source}`)
		let data = ''
		try {
			switch (source.type) {
				case 'remote': {
					const resp = await fetch(source.source)
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
				default:
					throw new Error(`Unsupported AdminList type:${source.type}`)
			}
		} catch (error) {
			ctx.log.error(`Error fetching ${source.type} admin list: ${source.source}`, error)
		}

		const groupRgx = /(?<=^Group=)(?<groupID>.*?):(?<groupPerms>.*?)(?=(?:\r\n|\r|\n|\s+\/\/))/gm
		const adminRgx = /(?<=^Admin=)(?<adminID>\d{17}|[a-f0-9]{32}):(?<groupID>\S+)/gm

		for (const m of data.matchAll(groupRgx)) {
			for (const perm of m.groups!.groupPerms.split(',')) {
				OneToMany.set(groups, m.groups!.groupID, perm)
			}
		}
		for (const m of data.matchAll(adminRgx)) {
			try {
				const adminID = BigInt(m.groups!.adminID)
				OneToMany.set(admins, adminID, m.groups!.groupID)
			} catch (error) {
				ctx.log.error(`Error parsing admin group ${m.groups!.groupID} from admin list: ${source.source}`, error)
			}
		}
	}
	ctx.log.trace(`${Object.keys(admins).length} admins loaded...`)
	return { admins, groups }
})
