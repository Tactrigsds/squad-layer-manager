import * as Crypto from 'node:crypto'
import * as Env from './env.ts'

// Symmetric encryption for secrets we persist (currently the RCON/SFTP passwords and server-agent token in a
// server's connection settings). Values are stored as a self-describing envelope so we can tell an encrypted
// value from a legacy plaintext one, and version the scheme if it ever changes.
//
// Envelope: `enc:v<n>:` + base64( iv(12) || authTag(16) || ciphertext ), AES-256-GCM.
//
// v1 envelopes predate SETTINGS_ENCRYPTION_KEY becoming any string hashed into the key: they were sealed with
// the key value base64-decoded straight to 32 bytes. The version records which derivation sealed a value, so a
// v1 one can be opened with the legacy key and re-sealed as v2 (see the backfill in settings.server.ts) rather
// than having to be re-entered by hand.

const envBuilder = Env.getEnvBuilder({ ...Env.groups.encryption })

const PREFIX_V1 = 'enc:v1:'
const PREFIX_V2 = 'enc:v2:'
const PREFIX = PREFIX_V2
const IV_BYTES = 12
const TAG_BYTES = 16

let key: Buffer | undefined

function getKey(): Buffer {
	if (!key) key = envBuilder().SETTINGS_ENCRYPTION_KEY
	return key
}

// The pre-hashing derivation: the key value base64-decoded to the cipher's 32 bytes. Only defined when the
// configured key decodes to exactly that, which it does for the `openssl rand -base64 32` output the docs told
// installs to use. A key that was always a passphrase never sealed a readable v1 envelope in the first place.
function getLegacyKey(): Buffer | undefined {
	const raw = Env.rawVar('SETTINGS_ENCRYPTION_KEY')
	if (!raw) return undefined
	const buf = Buffer.from(raw, 'base64')
	return buf.length === 32 ? buf : undefined
}

// Eagerly resolves the key so a missing/invalid SETTINGS_ENCRYPTION_KEY fails at boot rather than on the
// first settings write.
export function setup() {
	getKey()
}

export function isSealed(value: string): boolean {
	return value.startsWith(PREFIX_V2) || value.startsWith(PREFIX_V1)
}

// Whether this value is stored differently than `seal` would store it now: either it is plaintext, or it is a
// v1 envelope, which the current key derivation no longer produces. Lets the backfill rewrite exactly the
// values that need it -- every seal picks a fresh iv, so re-sealing unconditionally would look like a change
// on every boot.
export function needsReseal(value: string): boolean {
	return !isSealed(value) || value.startsWith(PREFIX_V1)
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
	const isV1 = value.startsWith(PREFIX_V1)
	const data = Buffer.from(value.slice((isV1 ? PREFIX_V1 : PREFIX_V2).length), 'base64')
	const iv = data.subarray(0, IV_BYTES)
	const tag = data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
	const ciphertext = data.subarray(IV_BYTES + TAG_BYTES)

	try {
		return decrypt(getKey(), iv, tag, ciphertext)
	} catch (err) {
		// a v1 envelope predates the current derivation, so it may have been sealed with the legacy key instead
		const legacyKey = isV1 ? getLegacyKey() : undefined
		if (!legacyKey) throw unreadable(err)
		try {
			return decrypt(legacyKey, iv, tag, ciphertext)
		} catch {
			throw unreadable(err)
		}
	}
}

// Re-encrypts under the current key and envelope version. Idempotent in effect but not in output: the
// ciphertext differs every call, so gate calls on `needsReseal`.
export function reseal(value: string): string {
	return seal(open(value))
}

function decrypt(key: Buffer, iv: Buffer, tag: Buffer, ciphertext: Buffer): string {
	const decipher = Crypto.createDecipheriv('aes-256-gcm', key, iv)
	decipher.setAuthTag(tag)
	return decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8')
}

// GCM reports an authentication failure as `Unsupported state or unable to authenticate data`, which says
// nothing about the actual cause: the value was sealed with a different SETTINGS_ENCRYPTION_KEY than the one
// configured now.
function unreadable(cause: unknown): Error {
	return new Error(
		'Could not decrypt a stored secret: it was encrypted with a different SETTINGS_ENCRYPTION_KEY than the one currently configured. '
			+ 'Restore the previous key, or re-enter the affected connection secrets on the settings page.',
		{ cause },
	)
}
