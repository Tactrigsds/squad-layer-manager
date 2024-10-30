import { Client as FTPClient } from 'basic-ftp'
import fs from 'fs'
import path from 'path'

import { PROJECT_ROOT } from '@/server/config.ts'
import * as C from '@/server/context.ts'

import * as SM from './squad-models.ts'
import WritableBuffer from './writable-buffer.ts'

export default async function fetchAdminLists(ctx: C.Log, sources: SM.AdminListSource[]) {
	ctx.log.debug(`Fetching Admin Lists...`)
	const groups: { [key: string]: string[] } = {}
	const admins: SM.SquadAdmins = {}

	for (const [idx, source] of sources.entries()) {
		let data = ''
		try {
			switch (source.type) {
				case 'remote': {
					const resp = await fetch(source.source)
					data = await resp.text()
					break
				}
				case 'local': {
					const listPath = path.resolve(PROJECT_ROOT, source.source)
					if (!fs.existsSync(listPath)) throw new Error(`Could not find Admin List at ${listPath}`)
					data = fs.readFileSync(listPath, 'utf8')
					break
				}
				case 'ftp': {
					// ex url: ftp//<user>:<password>@<host>:<port>/<url-path>
					if (!source.source.startsWith('ftp://')) {
						throw new Error(
							`Invalid FTP URI format of ${source.source}. The source must be a FTP URI starting with the protocol. Ex: ftp://username:password@host:21/some/file.txt`
						)
					}
					const [loginString, hostPathString] = source.source.substring('ftp://'.length).split('@')
					const [user, password] = loginString.split(':').map((v) => decodeURI(v))
					const pathStartIndex = hostPathString.indexOf('/')
					const remoteFilePath = pathStartIndex === -1 ? '/' : hostPathString.substring(pathStartIndex)
					const [host, port = 21] = hostPathString.substring(0, pathStartIndex === -1 ? hostPathString.length : pathStartIndex).split(':')

					const buffer = new WritableBuffer()
					const ftpClient = new FTPClient()
					await ftpClient.access({ host, port: port as number, user, password })
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
			groups[`${idx}-${m.groups!.groupID}`] = m.groups!.groupPerms.split(',')
		}
		for (const m of data.matchAll(adminRgx)) {
			try {
				const group = groups[`${idx}-${m.groups!.groupID}`]
				const perms: SM.SquadAdminPerms = {}
				for (const groupPerm of group) perms[groupPerm.toLowerCase()] = true

				const adminID = m.groups!.adminID
				if (adminID in admins) {
					admins[adminID] = Object.assign(admins[adminID], perms)
					ctx.log.debug(`Merged duplicate Admin ${adminID} to ${Object.keys(admins[adminID])}`)
				} else {
					admins[adminID] = Object.assign(perms)
					ctx.log.debug(`Added Admin ${adminID} with ${Object.keys(admins[adminID])}`)
				}
			} catch (error) {
				ctx.log.error(`Error parsing admin group ${m.groups!.groupID} from admin list: ${source.source}`, error)
			}
		}
	}
	ctx.log.trace(`${Object.keys(admins).length} admins loaded...`)
	return admins
}
