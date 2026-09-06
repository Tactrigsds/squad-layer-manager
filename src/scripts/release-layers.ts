import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import * as Paths from '$root/paths'
import * as LayerArtifacts from '@/systems/layer-artifacts.server'

// Rebuilds the layer artifact pair, ships it, and publishes it as a Layer Data release. Runs locally against
// the `gh` cli.
//
//   pnpm release:layers <version> [--csv <path>] [--csv-release <tag>] [--publish] [--dry-run] [--no-preflight]
//
// The pair in assets/layers is what the image ships, so a release is a commit on main as much as it is a
// release: build, run the e2e suite against what was built, commit and push the pair, then publish it. Each
// step gates the next, and the push happens before the release so nothing is announced that main does not have.
//
// Two of preprocess's inputs are not in the repo, and this recovers rather than asks for them:
//
//   the scores csv   ~150MB, so it rides on Layer Data releases; the newest one is fetched with `gh`
//   layer-db.json    deployment config, and gitignored -- but preprocess bakes the column defs it used into
//                    layer-data.json, so a pair already in assets/layers carries the config that built it
//
// The sources under data/sources are tracked, so everything downstream of them is reproducible from a checkout:
// this rebuilds the shipped v10.5.0 pair byte for byte. Refreshing those sources for a new game version is not
// part of it -- they are exports off a Squad install with the workshop mods, and reach a release by being
// committed first.

const RELEASE_PREFIX = 'layer-db-v'

type Args = {
	version: string
	csv?: string
	csvRelease?: string
	publish: boolean
	dryRun: boolean
	noPreflight: boolean
}

function usage(msg?: string): never {
	if (msg) console.error(`error: ${msg}\n`)
	console.error('usage: pnpm release:layers <version> [--csv <path>] [--csv-release <tag>] [--publish] [--dry-run] [--no-preflight]')
	console.error('')
	console.error('  <version>        what to stamp the pair with, e.g. 10.5.1 or 10.5.1-mods. No leading v.')
	console.error('  --csv            a scores csv to ingest, instead of fetching one off a release')
	console.error('  --csv-release    the release to fetch the csv from (default: the newest Layer Data release)')
	console.error('  --publish        publish the release rather than leaving it a draft')
	console.error('  --dry-run        build the pair, then stop: no tests, no commit, no release')
	console.error('  --no-preflight   build and release without the git checks, and without committing the pair')
	process.exit(1)
}

function parseArgs(argv: string[]): Args {
	const args: Args = { version: '', publish: false, dryRun: false, noPreflight: false }
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		switch (arg) {
			case '--csv':
				args.csv = argv[++i] ?? usage('--csv needs a path')
				break
			case '--csv-release':
				args.csvRelease = argv[++i] ?? usage('--csv-release needs a tag')
				break
			case '--publish':
				args.publish = true
				break
			case '--dry-run':
				args.dryRun = true
				break
			case '--no-preflight':
				args.noPreflight = true
				break
			default:
				if (arg.startsWith('-')) usage(`unknown option ${arg}`)
				if (args.version) usage('give one version')
				args.version = arg
		}
	}
	if (!args.version) usage('a version is required')
	// the leading v belongs to the filenames and the tag, not to the version itself
	if (args.version.startsWith('v')) usage(`drop the leading v: ${args.version.slice(1)}`)
	return args
}

function gh(...argv: string[]): string {
	return execFileSync('gh', argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()
}

function git(...argv: string[]): string {
	return execFileSync('git', argv, { encoding: 'utf8' }).trim()
}

function run(command: string, argv: string[], env?: NodeJS.ProcessEnv) {
	const res = spawnSync(command, argv, { stdio: 'inherit', env: { ...process.env, ...env } })
	if (res.status !== 0) throw new Error(`${command} ${argv.join(' ')} exited with ${res.status ?? res.signal}`)
}

function requireGh() {
	try {
		gh('auth', 'status')
	} catch {
		throw new Error('gh is not installed or not logged in. Install the GitHub cli and run `gh auth login`.')
	}
}

// A release commits the pair and pushes it, so it has to start from a checkout with nothing else in flight: a
// dirty tree sweeps unrelated work into that commit, and a main behind origin fails the push after the build and
// the e2e suite have already run.
function preflight() {
	const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
	if (branch !== 'main') throw new Error(`on ${branch}, not main. --no-preflight builds and releases without committing.`)
	const dirty = git('status', '--porcelain')
	if (dirty) throw new Error(`the working tree is not clean:\n${dirty}`)
	git('fetch', 'origin', 'main')
	if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) {
		throw new Error('main and origin/main have diverged. Pull or push before releasing.')
	}
}

// The release the csv comes off. Layer Data releases carry the csv they were built from, so the newest one is
// both the most recent scores and the thing the next build should chain from.
function newestLayerRelease(): string {
	const rows = JSON.parse(gh('release', 'list', '--limit', '100', '--json', 'tagName,createdAt')) as {
		tagName: string
		createdAt: string
	}[]
	const layerReleases = rows.filter((row) => row.tagName.startsWith('layer-db')).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
	if (layerReleases.length === 0) throw new Error('no Layer Data release to take a csv from; pass --csv with a local one')
	return layerReleases[0].tagName
}

function csvAssetOf(tag: string): string {
	const assets = (JSON.parse(gh('release', 'view', tag, '--json', 'assets')) as { assets: { name: string }[] }).assets
	const csvs = assets.filter((asset) => asset.name.endsWith('.csv'))
	if (csvs.length !== 1) {
		throw new Error(`expected one csv on ${tag}, found ${csvs.length === 0 ? 'none' : csvs.map((c) => c.name).join(', ')}`)
	}
	return csvs[0].name
}

// preprocess reads the config from a file, so an absent layer-db.json is recovered into a temp one rather than
// written into the checkout. A local layer-db.json wins: it is the deployment's own answer.
function resolveColumnConfig(): { configPath: string; description: string } {
	const local = path.join(Paths.PROJECT_ROOT, 'layer-db.json')
	if (fs.existsSync(local)) return { configPath: local, description: 'layer-db.json' }

	const pairs = fs
		.readdirSync(Paths.LAYERS)
		.filter((entry) => entry.startsWith('layer-data_v') && entry.endsWith('.json'))
		.sort()
	for (const pair of pairs.reverse()) {
		const data = JSON.parse(fs.readFileSync(path.join(Paths.LAYERS, pair), 'utf8')) as { extraColumns?: unknown[] }
		if (!data.extraColumns?.length) continue
		const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'slm-layer-db-')), 'layer-db.json')
		fs.writeFileSync(configPath, JSON.stringify({ columns: data.extraColumns }, null, 2))
		return { configPath, description: `${data.extraColumns.length} columns recovered from ${pair}` }
	}
	throw new Error('no layer-db.json, and no pair in assets/layers carries extra columns to recover one from')
}

// Only the two the repo tracks. The uncompressed table is 12MB of the same bytes and the csv is 150MB of input,
// so both stay out of git while still going on the release.
function trackedOf(version: string) {
	return [
		path.join(Paths.LAYERS, LayerArtifacts.layerDataFileName(version)),
		path.join(Paths.LAYERS, LayerArtifacts.tableFileName(version, { compressed: true })),
	]
}

function commitAndPush(version: string) {
	const tracked = trackedOf(version)
	git('add', '--', ...tracked)
	if (!git('status', '--porcelain', '--', ...tracked)) {
		console.log('the pair is identical to what main already has; nothing to commit')
		return
	}
	git('commit', '-m', `chore(layers): ship the v${version} artifact pair`)
	run('git', ['push', 'origin', 'main'])
}

function main() {
	const args = parseArgs(process.argv.slice(2))
	const { version } = args
	const tag = `${RELEASE_PREFIX}${version}`

	if (!args.noPreflight && !args.dryRun) preflight()

	if (!args.dryRun) {
		requireGh()
		const existing = spawnSync('gh', ['release', 'view', tag], { stdio: 'ignore' })
		if (existing.status === 0) throw new Error(`${tag} already exists. Pick another version, or delete that release first.`)
	}

	// --- the csv ---

	fs.mkdirSync(Paths.DATA, { recursive: true })
	const csvPath = path.join(Paths.DATA, `layers_v${version}.csv`)
	if (args.csv) {
		fs.copyFileSync(path.resolve(args.csv), csvPath)
		console.log(`csv: ${args.csv}`)
	} else if (fs.existsSync(csvPath)) {
		console.log(`csv: ${path.relative(Paths.PROJECT_ROOT, csvPath)}, already here`)
	} else {
		requireGh()
		const csvRelease = args.csvRelease ?? newestLayerRelease()
		const asset = csvAssetOf(csvRelease)
		console.log(`csv: fetching ${asset} from ${csvRelease}`)
		gh('release', 'download', csvRelease, '--pattern', asset, '--output', csvPath)
	}

	// --- the column config ---

	const { configPath, description } = resolveColumnConfig()
	console.log(`columns: ${description}`)

	// --- build ---

	run('pnpm', ['preprocess'], {
		NODE_ENV: process.env.NODE_ENV ?? 'production',
		LOG_LEVEL_OVERRIDE: process.env.LOG_LEVEL_OVERRIDE ?? 'info',
		LAYERS_VERSION: version,
		LAYER_DB_CONFIG_PATH: configPath,
		LAYERS_OUTPUT_DIR: Paths.LAYERS,
	})

	const files = [
		...trackedOf(version),
		path.join(Paths.LAYERS, LayerArtifacts.tableFileName(version)),
		// the csv rides along so every Layer Data release stays self-contained, and the next build has something to
		// chain from
		csvPath,
	]
	for (const file of files) {
		if (!fs.existsSync(file)) throw new Error(`preprocess did not write ${file}`)
	}

	console.log('')
	for (const file of files) {
		console.log(`  ${path.basename(file)}  ${(fs.statSync(file).size / 1e6).toFixed(1)} MB`)
	}
	console.log('')

	if (args.dryRun) {
		console.log('--dry-run: built, nothing tested, committed or released')
		return
	}

	// --- the pair has to hold the app up before it goes anywhere ---

	console.log('running the e2e suite against the pair just built')
	run('pnpm', ['test:e2e'], { LAYERS_VERSION: version })

	// --- ship it ---

	if (args.noPreflight) console.log('--no-preflight: leaving the pair uncommitted')
	else commitAndPush(version)

	const notes = `The layer artifact pair \`pnpm preprocess\` builds from the sources under \`data/sources\` (vanilla, supermod,
resurgence, galactic-contention) and the attached csv.

Put the pair in a directory SLM searches and pin \`LAYERS_VERSION=${version}\`, or leave \`@latest\` where this is the
highest version present. Not required to run SLM, which ships this pair in its image, and the attached source code is
irrelevant.`

	const notesPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'slm-release-')), 'notes.md')
	fs.writeFileSync(notesPath, notes)

	run('gh', [
		'release',
		'create',
		tag,
		'--title',
		`Layer Data (v${version})`,
		'--notes-file',
		notesPath,
		'--prerelease',
		...(args.publish ? [] : ['--draft']),
		...files,
	])

	console.log('')
	console.log(args.publish ? `released ${tag}` : `drafted ${tag}; publish it from the releases page when the pair looks right`)
}

try {
	main()
} catch (err) {
	console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
	process.exit(1)
}
