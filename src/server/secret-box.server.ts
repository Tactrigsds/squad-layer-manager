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
//
// Rotation: SETTINGS_ENCRYPTION_KEY_PREVIOUS names the key the current one replaced. `open` falls back to it,
// and `needsReseal` reports a value the current key alone cannot open, so the same backfill re-seals everything
// under the new key on the first boot after the swap. The envelope carries no key id, so telling the two apart
// costs a trial decryption, which is nothing against a handful of rows once per boot.

const envBuilder = Env.getEnvBuilder({ ...Env.groups.encryption })

const PREFIX_V1 = 'enc:v1:'
const PREFIX_V2 = 'enc:v2:'
const PREFIX = PREFIX_V2
const IV_BYTES = 12
const TAG_BYTES = 16

type Keys = { current: Buffer; previous: Buffer | undefined }
let keys: Keys | undefined

function getKeys(): Keys {
	if (!keys) {
		const env = envBuilder()
		keys = { current: env.SETTINGS_ENCRYPTION_KEY, previous: env.SETTINGS_ENCRYPTION_KEY_PREVIOUS }
	}
	return keys
}

// The pre-hashing derivation: a key value base64-decoded to the cipher's 32 bytes. Only defined for a value
// that decodes to exactly that, which the `openssl rand -base64 32` output the docs told installs to use does.
// A key that was always a passphrase never sealed a readable v1 envelope in the first place.
function legacyKeys(): Buffer[] {
	const out: Buffer[] = []
	for (const name of ['SETTINGS_ENCRYPTION_KEY', 'SETTINGS_ENCRYPTION_KEY_PREVIOUS']) {
		const raw = Env.rawVar(name)
		if (!raw) continue
		const buf = Buffer.from(raw, 'base64')
		if (buf.length === 32) out.push(buf)
	}
	return out
}

// Eagerly resolves the keys so a missing, invalid, public or weak SETTINGS_ENCRYPTION_KEY fails at boot rather
// than on the first settings write.
export function setup() {
	Env.assertEncryptionKeyIsStrong()
	getKeys()
}

export function isSealed(value: string): boolean {
	return value.startsWith(PREFIX_V2) || value.startsWith(PREFIX_V1)
}

// Whether this value is stored differently than `seal` would store it now: plaintext, a v1 envelope, or a v2
// envelope under a key other than the current one. Lets the backfill rewrite exactly the values that need it:
// every seal picks a fresh iv, so re-sealing unconditionally would look like a change on every boot.
export function needsReseal(value: string): boolean {
	if (!isSealed(value) || value.startsWith(PREFIX_V1)) return true
	const parts = split(value)
	try {
		decrypt(getKeys().current, parts)
		return false
	} catch {
		return true
	}
}

export function seal(plaintext: string): string {
	if (isSealed(plaintext)) return plaintext
	const iv = Crypto.randomBytes(IV_BYTES)
	const cipher = Crypto.createCipheriv('aes-256-gcm', getKeys().current, iv)
	const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
	const tag = cipher.getAuthTag()
	return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString('base64')
}

// Decrypts an envelope produced by `seal`, trying the current key, then the previous one, then for a v1
// envelope the legacy derivation of each. A value that isn't an envelope is returned unchanged, so a database
// written before encryption was introduced still reads until the boot backfill re-seals it.
export function open(value: string): string {
	if (!isSealed(value)) return value
	const isV1 = value.startsWith(PREFIX_V1)
	const parts = split(value)
	const { current, previous } = getKeys()
	const candidates = [current, ...(previous ? [previous] : []), ...(isV1 ? legacyKeys() : [])]
	let firstError: unknown
	for (const key of candidates) {
		try {
			return decrypt(key, parts)
		} catch (err) {
			firstError ??= err
		}
	}
	throw unreadable(firstError)
}

// Re-encrypts under the current key and envelope version. Idempotent in effect but not in output: the
// ciphertext differs every call, so gate calls on `needsReseal`.
export function reseal(value: string): string {
	return seal(open(value))
}

type Parts = { iv: Buffer; tag: Buffer; ciphertext: Buffer }

function split(value: string): Parts {
	const prefix = value.startsWith(PREFIX_V1) ? PREFIX_V1 : PREFIX_V2
	const data = Buffer.from(value.slice(prefix.length), 'base64')
	return {
		iv: data.subarray(0, IV_BYTES),
		tag: data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES),
		ciphertext: data.subarray(IV_BYTES + TAG_BYTES),
	}
}

function decrypt(key: Buffer, { iv, tag, ciphertext }: Parts): string {
	const decipher = Crypto.createDecipheriv('aes-256-gcm', key, iv)
	decipher.setAuthTag(tag)
	return decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8')
}

// GCM reports an authentication failure as `Unsupported state or unable to authenticate data`, which says
// nothing about the actual cause: the value was sealed with a SETTINGS_ENCRYPTION_KEY that is neither the one
// configured now nor SETTINGS_ENCRYPTION_KEY_PREVIOUS.
function unreadable(cause: unknown): Error {
	return new Error(
		'Could not decrypt a stored secret: it was encrypted with a SETTINGS_ENCRYPTION_KEY other than the one currently configured (or SETTINGS_ENCRYPTION_KEY_PREVIOUS). ' +
			'Restore the key that sealed it, set it as SETTINGS_ENCRYPTION_KEY_PREVIOUS to rotate away from it, or re-enter the affected connection secrets on the settings page.',
		{ cause },
	)
}
