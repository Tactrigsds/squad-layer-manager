import * as fs from 'node:fs'
import { Client } from 'ssh2'

// fetches the last N bytes of a remote log file over SFTP
const [host, portStr, username, password, remotePath, outPath, tailBytesStr] = process.argv.slice(2)
const tailBytes = Number(tailBytesStr ?? 4 * 1024 * 1024)

const client = new Client()
client.on('ready', () => {
	client.sftp((err, sftp) => {
		if (err) throw err
		sftp.stat(remotePath, (err, stats) => {
			if (err) throw err
			const start = Math.max(0, stats.size - tailBytes)
			console.log(`remote size: ${stats.size}, reading from offset ${start}`)
			const rs = sftp.createReadStream(remotePath, { start })
			const ws = fs.createWriteStream(outPath)
			rs.pipe(ws)
			ws.on('finish', () => {
				console.log(`wrote ${outPath}`)
				client.end()
			})
		})
	})
})
client.on('error', (e) => {
	console.error('ssh error:', e)
	process.exit(1)
})
client.connect({ host, port: Number(portStr), username, password })
