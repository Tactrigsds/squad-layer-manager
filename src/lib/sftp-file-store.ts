import fs from 'node:fs'
import path from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import { Client } from 'ssh2'

// a one-shot sftp session for pushing files at a remote directory (backups, currently). Distinct from SftpTail,
// which holds a long-lived connection open to poll a single file: here we connect, do the work, and disconnect.

export type SftpTarget = {
	host: string
	port: number
	username: string
	password?: string
	privateKey?: Buffer
	passphrase?: string
	timeout?: number
}

const DEFAULT_TIMEOUT = 30_000

export type SftpSession = {
	uploadFile: (localPath: string, remotePath: string) => Promise<void>
	listDir: (remoteDir: string) => Promise<string[]>
	unlink: (remotePath: string) => Promise<void>
	// creates the directory and any missing parents. no-op if it already exists.
	mkdirp: (remoteDir: string) => Promise<void>
}

export async function withSftp<T>(target: SftpTarget, fn: (session: SftpSession) => Promise<T>, signal?: AbortSignal): Promise<T> {
	signal?.throwIfAborted()
	const timeout = target.timeout ?? DEFAULT_TIMEOUT
	const client = new Client({ captureRejections: true })

	const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
		const onAbort = () => reject(signal!.reason)
		signal?.addEventListener('abort', onAbort, { once: true })
		client.once('error', reject)
		client.once('ready', () => {
			client.sftp((err, sftp) => {
				if (err) reject(err)
				else resolve(sftp)
			})
		})
		client.connect({
			host: target.host,
			port: target.port,
			username: target.username,
			password: target.password,
			privateKey: target.privateKey,
			passphrase: target.passphrase,
			readyTimeout: timeout,
		})
	}).finally(() => {
		// a socket error after we're connected must not become an unhandled 'error' event (which crashes the
		// process); the in-flight operation rejects on its own.
		client.removeAllListeners('error')
		client.on('error', () => {})
	})

	try {
		return await fn(buildSession(sftp, signal))
	} finally {
		client.end()
	}
}

function buildSession(sftp: SFTPWrapper, signal?: AbortSignal): SftpSession {
	function promisify<T>(fn: (cb: (err: Error | null | undefined, res: T) => void) => void) {
		signal?.throwIfAborted()
		return new Promise<T>((resolve, reject) => {
			fn((err, res) => {
				if (err) reject(err)
				else resolve(res)
			})
		})
	}

	const session: SftpSession = {
		uploadFile: (localPath, remotePath) => promisify<void>(cb => sftp.fastPut(localPath, remotePath, err => cb(err, undefined))),
		listDir: async (remoteDir) => {
			const entries = await promisify<{ filename: string }[]>(cb => sftp.readdir(remoteDir, cb))
			return entries.map(e => e.filename)
		},
		unlink: (remotePath) => promisify<void>(cb => sftp.unlink(remotePath, err => cb(err, undefined))),
		mkdirp: async (remoteDir) => {
			const segments = remoteDir.split('/').filter(Boolean)
			// a leading '/' is the only thing that distinguishes an absolute remote path from one relative to the
			// login directory, and splitting on '/' drops it
			let current = remoteDir.startsWith('/') ? '/' : ''
			for (const segment of segments) {
				current = current === '/' || current === '' ? `${current}${segment}` : `${current}/${segment}`
				try {
					await promisify<void>(cb => sftp.mkdir(current, err => cb(err, undefined)))
				} catch {
					// already exists (or we lack permission to create it, which the subsequent upload will report)
				}
			}
		},
	}
	return session
}

export function readPrivateKey(keyPath: string) {
	return fs.readFileSync(path.resolve(keyPath))
}
