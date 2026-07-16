import * as Crypto from 'node:crypto'
import * as Env from './env.ts'

// Symmetric encryption for secrets we persist (currently the RCON/SFTP passwords and server-agent token in a
// server's connection settings). Values are stored as a self-describing envelope so we can tell an encrypted
// value from a legacy plaintext one, and version the scheme if it ever changes.
//
// Envelope: `enc:v1:` + base64( iv(12) || authTag(16) || ciphertext ), AES-256-GCM.

const envBuilder = Env.getEnvBuilder({ ...Env.groups.encryption })

const PREFIX = 'enc:v1:'
const IV_BYTES = 12
const TAG_BYTES = 16

let key: Buffer | undefined

function getKey(): Buffer {
	if (!key) key = envBuilder().SETTINGS_ENCRYPTION_KEY
	return key
}

// Eagerly resolves the key so a missing/invalid SETTINGS_ENCRYPTION_KEY fails at boot rather than on the
// first settings write.
export function setup() {
	getKey()
}

export function isSealed(value: string): boolean {
	return value.startsWith(PREFIX)
}

export function seal(plaintext: string): string {
	if (isSealed(plaintext)) return plaintext
	const iv = Crypto.randomBytes(IV_BYTES)
	const cipher = Crypto.createCipheriv('aes-256-gcm', getKey(), iv)
	const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
	const tag = cipher.getAuthTag()
	return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString('base64')
}

// Decrypts an envelope produced by `seal`. A value that isn't an envelope is returned unchanged, so a
// database written before encryption was introduced still reads until the boot backfill re-seals it.
export function open(value: string): string {
	if (!isSealed(value)) return value
	const data = Buffer.from(value.slice(PREFIX.length), 'base64')
	const iv = data.subarray(0, IV_BYTES)
	const tag = data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
	const ciphertext = data.subarray(IV_BYTES + TAG_BYTES)
	const decipher = Crypto.createDecipheriv('aes-256-gcm', getKey(), iv)
	decipher.setAuthTag(tag)
	return decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8')
}
