import * as Paths from '$root/paths'
import { escapeRegex } from '@/lib/string'
import * as LA from '@/models/layer-artifact'
import * as Env from '@/server/env'
import Mustache from 'mustache'
import fs from 'node:fs'
import path from 'node:path'
import * as semver from 'semver'

// Where the layer artifacts come from, and which version of them the app runs on.
//
// A version is only usable as a *pair*: the columnar table the query engine reads
// (layers_v<version>.bin[.gz]) and the components its encoded values index into
// (layer-data_v<version>.json). A table read against the wrong components resolves to the wrong layers
// silently, so a pair is only ever formed from two files sitting in the same directory under the same
// version, and a version with only one half of it present is an error rather than something to skip past.
//
// Directories are searched in order and the first one holding a usable pair wins:
//
//   1. LAYERS_DIR, if set
//   2. ./data -- what a deployment mounts. Any complete pair here beats the one in the image, including an
//      older one: dropping a table into the mount is how a running deployment moves between layer versions.
//   3. assets/layers -- ships with the image, so a fresh checkout and a bare deployment both boot.

export type ArtifactPair = {
	version: string
	tablePath: string
	layerDataPath: string
	dir: string
}

const TABLE_PREFIX = 'layers_v'
const LAYER_DATA_PREFIX = 'layer-data_v'
const LAYER_DATA_EXT = '.json'

export function tableFileName(version: string, opts?: { compressed?: boolean }) {
	return `${TABLE_PREFIX}${version}${LA.ARTIFACT_EXT}${opts?.compressed ? '.gz' : ''}`
}

export function layerDataFileName(version: string) {
	return `${LAYER_DATA_PREFIX}${version}${LAYER_DATA_EXT}`
}

const envBuilder = Env.getEnvBuilder({ ...Env.groups.layers, ...Env.groups.general })
let _env: ReturnType<typeof envBuilder> | undefined
// preprocess resolves paths before anything has called Env.ensureEnvSetup(), so the env is built on first use
function env() {
	Env.ensureEnvSetup()
	_env ??= envBuilder()
	return _env
}

let resolved: ArtifactPair | undefined

export function resolvePair(): ArtifactPair {
	resolved ??= resolve()
	return resolved
}

function searchDirs(): string[] {
	const dirs = [env().LAYERS_DIR, Paths.DATA, Paths.LAYERS].filter((dir): dir is string => !!dir)
	return [...new Set(dirs.map((dir) => path.resolve(dir)))]
}

function resolve(): ArtifactPair {
	const wanted = env().LAYERS_VERSION
	const dirs = searchDirs()
	for (const dir of dirs) {
		if (!fs.existsSync(dir)) continue
		const pairs = scanPairs(dir)
		if (pairs.length === 0) continue
		if (wanted === '@latest') return pairs[pairs.length - 1]
		const match = pairs.find((pair) => pair.version === wanted)
		if (match) return match
	}

	const searched = dirs.map((dir) => `  - ${dir}`).join('\n')
	const version = wanted === '@latest' ? 'any version' : `version ${wanted}`
	throw new Error(
		`No layer artifacts for ${version}: a directory must hold both ${tableFileName('<version>', { compressed: true })} `
			+ `(or ${tableFileName('<version>')}) and ${layerDataFileName('<version>')}. Searched:\n${searched}\n`
			+ `Build them with \`pnpm preprocess\`, or download a published pair into ./data.`,
	)
}

// every complete pair in `dir`, oldest first. A half-pair is fatal: it is always a mistake, and skipping it
// would quietly run the app on some other version than the one that was just put there.
function scanPairs(dir: string): ArtifactPair[] {
	const tables = new Map<string, string>()
	const layerData = new Map<string, string>()

	const tableRegex = new RegExp(`^${escapeRegex(TABLE_PREFIX)}(.+)${escapeRegex(LA.ARTIFACT_EXT)}(\\.gz)?$`)
	const layerDataRegex = new RegExp(`^${escapeRegex(LAYER_DATA_PREFIX)}(.+)${escapeRegex(LAYER_DATA_EXT)}$`)

	for (const entry of fs.readdirSync(dir)) {
		const tableMatch = entry.match(tableRegex)
		if (tableMatch) {
			const version = semver.valid(tableMatch[1])
			// the uncompressed table loads quicker, so it wins when preprocess has left both behind
			if (version && !(tables.get(version)?.endsWith(LA.ARTIFACT_EXT))) tables.set(version, path.join(dir, entry))
			continue
		}
		const layerDataMatch = entry.match(layerDataRegex)
		if (layerDataMatch) {
			const version = semver.valid(layerDataMatch[1])
			if (version) layerData.set(version, path.join(dir, entry))
		}
	}

	for (const [version, tablePath] of tables) {
		if (!layerData.has(version)) {
			throw new Error(
				`${tablePath} has no ${layerDataFileName(version)} beside it. The table's encoded values are meaningless `
					+ `without the components they index into, so the two always travel together. Add it, or remove the table.`,
			)
		}
	}
	for (const [version, layerDataPath] of layerData) {
		if (!tables.has(version)) {
			throw new Error(
				`${layerDataPath} has no ${tableFileName(version, { compressed: true })} beside it. Add it, or remove the components file.`,
			)
		}
	}

	return [...tables.entries()]
		.sort(([a], [b]) => semver.compare(a, b))
		.map(([version, tablePath]) => ({ version, tablePath, layerDataPath: layerData.get(version)!, dir }))
}

// resolves {{LAYERS_VERSION}} in a path, picking the highest semver present when the version is `@latest`.
// only preprocess still needs this: it reads a versioned csv that lives outside the pair.
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
