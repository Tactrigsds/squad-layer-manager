import * as Paths from '$root/paths'
import { escapeRegex } from '@/lib/string'
import type * as CS from '@/models/context-shared'
import * as Env from '@/server/env'
import { initModule } from '@/server/logger'
import { LayerEngine } from '@/systems/layer-engine.shared'
import crypto from 'crypto'
import Mustache from 'mustache'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import * as semver from 'semver'

const gunzip = promisify(zlib.gunzip)
const module = initModule('layer-engine')
let log!: CS.Logger

// The server's copy of the query engine. Unlike the SQLite layer db it replaced, the artifact is just bytes: it loads
// straight into wasm memory, so there is no decompress-to-disk step, no file handle, and no schema.

export let engine!: LayerEngine
export let hash!: string
export let layersVersion!: string
/// resolves once the artifact is loaded. `engine` and `hash` are only populated after this settles.
export let ready!: Promise<void>
let artifactPath!: string

const envBuilder = Env.getEnvBuilder({ ...Env.groups.layerDb, ...Env.groups.general })
let _env: ReturnType<typeof envBuilder> | undefined
// getVersionTemplatedPath resolves paths for callers that haven't loaded the engine (preprocess picks the csv and
// artifact paths before setup()), so the env is built on first use rather than in setup()
function env() {
	_env ??= envBuilder()
	return _env
}

export function setup(): Promise<void> {
	log = module.getLogger()
	;[artifactPath, layersVersion] = getVersionTemplatedPath(env().LAYERS_ARTIFACT_PATH)
	ready = load()
	return ready
}

async function load() {
	const fileBytes = await fs.promises.readFile(artifactPath)
	// the artifact is served to clients as it sits on disk, so the etag hashes the on-disk bytes
	hash = crypto.createHash('sha256').update(fileBytes).digest('hex')
	const artifact = artifactPath.endsWith('.gz') ? await gunzip(fileBytes) : fileBytes

	const wasm = await fs.promises.readFile(path.join(Paths.ASSETS, 'layer-engine.wasm'))
	engine = await LayerEngine.create(wasm, new Uint8Array(artifact))
	log.info('Loaded the layer engine from %s: %s layers', artifactPath, engine.rowCount)
}

export function readFilestream(): [fs.ReadStream, string] {
	if (!fs.existsSync(artifactPath)) throw new Error('File does not exist: ' + artifactPath)
	const contentType = artifactPath.endsWith('.gz') ? 'application/gzip' : 'application/octet-stream'
	return [fs.createReadStream(artifactPath), contentType]
}

// resolves {{LAYERS_VERSION}} in a path, picking the highest semver present when the version is `@latest`
export function getVersionTemplatedPath(filePath: string): [string, string] {
	if (!filePath.includes('{{LAYERS_VERSION}}')) {
		return [filePath, 'unknown']
	}

	if (env().LAYERS_VERSION === '@latest') {
		const segments = filePath.split('/')
		const segmentIndex = segments.findIndex((segment) => segment.includes('{{LAYERS_VERSION}}'))
		if (segmentIndex === -1) return [filePath, 'unknown']
		const [before, after] = segments[segmentIndex].split('{{LAYERS_VERSION}}')
		const dir = segments.slice(0, segmentIndex).join('/')

		const regex = new RegExp(`^${escapeRegex(before)}([^/]+)${escapeRegex(after)}$`)
		const matches: Array<{ segment: string; version: string }> = []
		for (const segment of fs.readdirSync(dir)) {
			const match = segment.match(regex)
			if (match && match[1]) {
				const validVersion = semver.valid(match[1])
				if (validVersion) matches.push({ segment, version: validVersion })
			}
		}

		if (matches.length === 0) {
			const expectedPattern = Mustache.render(filePath, { LAYERS_VERSION: '<version>' })
			throw new Error(
				`No files found matching ${expectedPattern} where <version> is a valid semver (e.g., 1.2.3, v2.0.0-beta.1)`,
			)
		}

		const versions = matches.sort((a, b) => semver.compare(a.version, b.version))
		const latest = versions[versions.length - 1]
		const modifiedSegments = [...segments]
		modifiedSegments[segmentIndex] = latest.segment
		return [modifiedSegments.join('/'), latest.version]
	}

	return [Mustache.render(filePath, { LAYERS_VERSION: env().LAYERS_VERSION }), env().LAYERS_VERSION]
}
