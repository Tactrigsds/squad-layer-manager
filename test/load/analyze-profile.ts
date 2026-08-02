import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseArgs } from 'node:util'

// Reads a .cpuprofile from a load run and prints where the time went, resolved back through the bundle's
// source maps to the files it was written in. `pnpm load:analyze <run-dir-or-file>`.
//
// DevTools and speedscope open the same file and show more; this exists because the first question after a run
// is always "what is at the top", and answering it should not need a browser.

const args = parseArgs({
	options: {
		top: { type: 'string', default: '30' },
		// aggregate by the file a frame came from rather than by the function
		'by-file': { type: 'boolean', default: false },
		// include frames from node_modules, which are excluded by default: the map data for dependencies is not
		// shipped (see register-source-maps.mjs) and they are rarely what a change would touch
		deps: { type: 'boolean', default: false },
	},
	allowPositionals: true,
})

const target = args.positionals[0]
if (!target) {
	console.error('usage: pnpm load:analyze <run-dir|profile.cpuprofile> [--top 30] [--by-file] [--deps]')
	process.exit(2)
}
const profilePath = fs.statSync(target).isDirectory() ? path.join(target, 'server.cpuprofile') : target

type CallFrame = { functionName: string; url: string; lineNumber: number; columnNumber: number }
type ProfileNode = { id: number; callFrame: CallFrame; hitCount?: number; children?: number[] }
type CpuProfile = { nodes: ProfileNode[]; startTime: number; endTime: number; samples: number[]; timeDeltas: number[] }

const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8')) as CpuProfile

// Self time per node, from the sample stream rather than hitCount: timeDeltas are the actual microseconds
// between samples, so a run whose sampler fell behind is reported as it happened.
const selfTimeUs = new Map<number, number>()
for (let i = 0; i < profile.samples.length; i++) {
	const nodeId = profile.samples[i]
	selfTimeUs.set(nodeId, (selfTimeUs.get(nodeId) ?? 0) + (profile.timeDeltas[i] ?? 0))
}

const totalUs = profile.endTime - profile.startTime

// -------- source maps --------

type SourceMap = { sources: string[]; sourcesContent?: (string | null)[]; mappings: string }
const mapCache = new Map<string, DecodedMap | null>()

// The generated-line -> [generatedColumn, sourceIndex, sourceLine] segments a v3 map encodes, decoded once per
// file. Only what a frame needs: the original name index is not read, because a bundle keeps function names.
type DecodedMap = { sources: string[]; lines: [number, number, number][][] }

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function decodeVlq(segment: string): number[] {
	const values: number[] = []
	let shift = 0
	let value = 0
	for (const char of segment) {
		const digit = BASE64.indexOf(char)
		if (digit === -1) return values
		const shouldContinue = digit & 32
		value += (digit & 31) << shift
		if (shouldContinue) {
			shift += 5
			continue
		}
		const negative = value & 1
		value >>= 1
		values.push(negative ? (value === 0 ? -0x80000000 : -value) : value)
		value = 0
		shift = 0
	}
	return values
}

function decodeMappings(raw: SourceMap): DecodedMap {
	const lines: [number, number, number][][] = []
	let sourceIndex = 0
	let sourceLine = 0
	for (const lineRaw of raw.mappings.split(';')) {
		const segments: [number, number, number][] = []
		let generatedColumn = 0
		for (const segmentRaw of lineRaw.split(',')) {
			if (!segmentRaw) continue
			const fields = decodeVlq(segmentRaw)
			generatedColumn += fields[0] ?? 0
			if (fields.length >= 4) {
				sourceIndex += fields[1]
				sourceLine += fields[2]
				segments.push([generatedColumn, sourceIndex, sourceLine])
			}
		}
		lines.push(segments)
	}
	return { sources: raw.sources, lines }
}

function loadMap(fileUrl: string): DecodedMap | null {
	if (mapCache.has(fileUrl)) return mapCache.get(fileUrl)!
	let decoded: DecodedMap | null = null
	try {
		const file = fileUrl.startsWith('file://') ? fileUrl.slice('file://'.length) : fileUrl
		const raw = JSON.parse(fs.readFileSync(`${file}.map`, 'utf8')) as SourceMap
		decoded = decodeMappings(raw)
	} catch {
		decoded = null
	}
	mapCache.set(fileUrl, decoded)
	return decoded
}

// A cpuprofile's lineNumber/columnNumber are 0-based, which is what a source map's generated positions are too.
// The segment wanted is the last one at or before the frame's column on that line.
function originalPosition(frame: CallFrame): { source: string; line: number } | null {
	const map = loadMap(frame.url)
	const segments = map?.lines[frame.lineNumber]
	if (!map || !segments || segments.length === 0) return null
	let best = segments[0]
	for (const segment of segments) {
		if (segment[0] > frame.columnNumber) break
		best = segment
	}
	return { source: map.sources[best[1]] ?? '?', line: best[2] + 1 }
}

// -------- aggregation --------

const byKey = new Map<string, { us: number; label: string }>()
for (const node of profile.nodes) {
	const us = selfTimeUs.get(node.id) ?? 0
	if (us === 0) continue
	const frame = node.callFrame
	const isDep = frame.url.includes('/node_modules/')
	if (isDep && !args.values.deps) continue

	const original = frame.url.startsWith('file://') ? originalPosition(frame) : null
	const where = original ? `${tidy(original.source)}:${original.line}` : tidy(frame.url) || '(native)'
	const label = args.values['by-file'] ? where.split(':')[0] : `${frame.functionName || '(anonymous)'}  ${where}`
	const key = label
	byKey.set(key, { us: (byKey.get(key)?.us ?? 0) + us, label })
}

function tidy(source: string): string {
	return source
		.replace(/^file:\/\//, '')
		.replace(/^.*\/node_modules\//, 'node_modules/')
		.replace(/^(\.\.\/)+/, '')
		.replace(/^.*\/(src|dist-server)\//, '$1/')
}

const rows = [...byKey.values()].sort((a, b) => b.us - a.us).slice(0, Number(args.values.top))
const measuredUs = [...byKey.values()].reduce((sum, row) => sum + row.us, 0)

console.log(`${path.relative(process.cwd(), profilePath)}`)
console.log(
	`profile spans ${(totalUs / 1e6).toFixed(1)}s; ${(measuredUs / 1e6).toFixed(2)}s of self time attributed` +
		`${args.values.deps ? '' : ' (our code only -- pass --deps to include dependencies)'}\n`,
)
console.log(`${'self'.padStart(9)}  ${'% of run'.padStart(8)}  where`)
for (const row of rows) {
	console.log(`${(row.us / 1000).toFixed(0).padStart(7)}ms  ${((row.us / totalUs) * 100).toFixed(2).padStart(7)}%  ${row.label}`)
}
