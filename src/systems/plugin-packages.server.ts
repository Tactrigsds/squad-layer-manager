import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

import type * as CS from '@/models/context-shared'
import * as PLG from '@/models/plugins.models'
import * as Env from '@/server/env'
import { initModule } from '@/server/logger'

// The plugins directory: one subdirectory per packaged plugin, each holding a plugin.json and the
// prebuilt esm bundles it names. It lives under data/, which a deployment already bind-mounts, so a
// plugin survives image upgrades and can be dropped in by hand.
//
// Installing from a url writes into the same directory rather than a cache: what runs is always a
// local copy, and refresh is an explicit re-fetch of a recorded source. Nothing is fetched at boot.

const module = initModule('plugin-packages')
const envBuilder = Env.getEnvBuilder({ ...Env.groups.plugins })
let log!: CS.Logger
let PLUGINS_DIR!: string

// generous for a bundle, small enough that a wrong url cannot fill the disk
const MAX_FILE_BYTES = 16 * 1024 * 1024
const FETCH_TIMEOUT_MS = 30_000

export type Package = {
	id: string
	dir: string
	manifest: PLG.PackageManifest
	manifestPath: string
	serverPath: string
	clientPath: string | null
	// content hashes, which is what makes a reload of an upgraded bundle possible: they go in the
	// module url the server imports and in the asset url the browser imports
	manifestAssetId: string
	serverAssetId: string
	clientAssetId: string | null
	// present only for a package SLM fetched; a hand-placed directory has no source to refresh from
	install: PLG.InstallRecord | null
}

export function setup() {
	log = module.getLogger()
	PLUGINS_DIR = envBuilder().PLUGINS_DIR
	fs.mkdirSync(PLUGINS_DIR, { recursive: true })
}

export function dir(): string {
	return PLUGINS_DIR
}

function assetId(bytes: Buffer | string): string {
	return createHash('sha256').update(bytes).digest('hex').slice(0, 12)
}

// ---- reading ----

export function scan(): Package[] {
	const out: Package[] = []
	for (const name of fs.readdirSync(PLUGINS_DIR).sort()) {
		if (name.startsWith('.')) continue
		const dir = path.join(PLUGINS_DIR, name)
		if (!fs.statSync(dir).isDirectory()) continue
		try {
			out.push(readPackage(dir))
		} catch (err) {
			log.error(err, 'ignoring plugin directory %s', name)
		}
	}
	return out
}

export function readPackage(dir: string): Package {
	const manifestPath = path.join(dir, PLG.PACKAGE_MANIFEST_FILE)
	if (!fs.existsSync(manifestPath)) throw new Error(`no ${PLG.PACKAGE_MANIFEST_FILE}`)
	const manifest = PLG.PackageManifestSchema.parse(JSON.parse(fs.readFileSync(manifestPath, 'utf8')))
	if (manifest.id !== path.basename(dir)) throw new Error(`plugin.json id '${manifest.id}' does not match its directory name`)

	const manifestModulePath = resolveWithin(dir, manifest.manifest)
	const serverPath = resolveWithin(dir, manifest.server)
	const clientPath = manifest.client ? resolveWithin(dir, manifest.client) : null
	return {
		id: manifest.id,
		dir,
		manifest,
		manifestPath: manifestModulePath,
		serverPath,
		clientPath,
		manifestAssetId: assetId(fs.readFileSync(manifestModulePath)),
		serverAssetId: assetId(fs.readFileSync(serverPath)),
		clientAssetId: clientPath ? assetId(fs.readFileSync(clientPath)) : null,
		install: readInstallRecord(dir),
	}
}

function readInstallRecord(dir: string): PLG.InstallRecord | null {
	const p = path.join(dir, PLG.INSTALL_RECORD_FILE)
	if (!fs.existsSync(p)) return null
	try {
		return PLG.InstallRecordSchema.parse(JSON.parse(fs.readFileSync(p, 'utf8')))
	} catch {
		return null
	}
}

// a manifest naming '../../etc/passwd' as its bundle would otherwise be read (and later served)
function resolveWithin(dir: string, rel: string): string {
	const resolved = path.resolve(dir, rel)
	if (resolved !== dir && !resolved.startsWith(dir + path.sep)) throw new Error(`'${rel}' escapes the plugin directory`)
	if (!fs.existsSync(resolved)) throw new Error(`'${rel}' does not exist`)
	return resolved
}

// ---- installing ----

export type InstallResult = { code: 'ok'; pkg: Package } | { code: 'err:install-failed'; message: string }

// Fetches a plugin.json and the bundles it names, then swaps the whole directory into place. The url
// points at the manifest; everything else is resolved relative to it, so a package is one directory
// on a static host.
export async function installFromUrl(ctx: CS.AbortSignal, url: string): Promise<InstallResult> {
	try {
		const manifestUrl = new URL(url)
		if (manifestUrl.protocol !== 'http:' && manifestUrl.protocol !== 'https:') throw new Error('only http(s) urls can be installed')

		const manifestBytes = await fetchFile(ctx, manifestUrl)
		const manifest = PLG.PackageManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')))
		if (!PLG.satisfiesApiVersion(manifest.apiVersion)) {
			throw new Error(`plugin requires slm api ${manifest.apiVersion}, this build provides ${PLG.formatApiVersion()}`)
		}

		const files = new Map<string, Buffer>([[PLG.PACKAGE_MANIFEST_FILE, manifestBytes]])
		for (const rel of [manifest.manifest, manifest.server, ...(manifest.client ? [manifest.client] : [])]) {
			if (path.isAbsolute(rel) || rel.split('/').includes('..')) throw new Error(`plugin.json names an unusable path: ${rel}`)
			files.set(rel, await fetchFile(ctx, new URL(rel, manifestUrl)))
		}
		const record: PLG.InstallRecord = {
			sourceUrl: manifestUrl.href,
			installedAt: Date.now(),
			files: Object.fromEntries([...files].map(([rel, bytes]) => [rel, createHash('sha256').update(bytes).digest('hex')])),
		}
		files.set(PLG.INSTALL_RECORD_FILE, Buffer.from(JSON.stringify(record, null, '\t')))

		await swapIn(manifest.id, files)
		log.info('installed plugin %s v%s from %s', manifest.id, manifest.version, manifestUrl.href)
		return { code: 'ok', pkg: readPackage(path.join(PLUGINS_DIR, manifest.id)) }
	} catch (err) {
		log.error(err, 'installing %s failed', url)
		return { code: 'err:install-failed', message: err instanceof Error ? err.message : String(err) }
	}
}

// re-fetches a url-installed package from the source it recorded
export async function refresh(ctx: CS.AbortSignal, pkg: Package): Promise<InstallResult> {
	if (!pkg.install) return { code: 'err:install-failed', message: 'this plugin was placed by hand; there is nothing to refresh from' }
	return await installFromUrl(ctx, pkg.install.sourceUrl)
}

export async function remove(id: PLG.PluginId) {
	const dir = path.join(PLUGINS_DIR, id)
	if (!fs.existsSync(dir)) return
	await fsp.rm(dir, { recursive: true, force: true })
	log.info('removed plugin directory %s', id)
}

// Writes to a scratch directory and renames, so a failed download never leaves a half-written plugin
// where the next boot would load it.
async function swapIn(id: PLG.PluginId, files: Map<string, Buffer>) {
	const target = path.join(PLUGINS_DIR, id)
	const staging = path.join(PLUGINS_DIR, `.staging-${id}`)
	await fsp.rm(staging, { recursive: true, force: true })
	for (const [rel, bytes] of files) {
		const dest = path.join(staging, rel)
		await fsp.mkdir(path.dirname(dest), { recursive: true })
		await fsp.writeFile(dest, bytes)
	}
	await fsp.rm(target, { recursive: true, force: true })
	await fsp.rename(staging, target)
}

async function fetchFile(ctx: CS.AbortSignal, url: URL): Promise<Buffer> {
	const res = await fetch(url, { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]), redirect: 'follow' })
	if (!res.ok) throw new Error(`GET ${url.href} returned ${res.status}`)
	const bytes = Buffer.from(await res.arrayBuffer())
	if (bytes.byteLength > MAX_FILE_BYTES) throw new Error(`${url.href} is larger than ${MAX_FILE_BYTES} bytes`)
	return bytes
}
