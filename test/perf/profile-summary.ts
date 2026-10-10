import fs from 'node:fs'
import path from 'node:path'

// Summarizes a CDP CPU profile of the production client: self time by package and by source file, and the source
// functions with the most inclusive time. Frames in dist/assets are mapped back to their source through the build's
// sourcemaps, so names and locations are the ones in src/.

type CallFrame = { functionName: string; url: string; lineNumber: number; columnNumber: number }
type ProfileNode = { id: number; callFrame: CallFrame; children?: number[] }
export type CpuProfile = { nodes: ProfileNode[]; samples?: number[]; timeDeltas?: number[] }

type Segment = [genCol: number, src: number, line: number, col: number, name: number]
type SourceMap = { sources: string[]; names: string[]; lines: Segment[][] }

const B64 = new Map(Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', (c, i) => [c, i]))

function decodeMappings(mappings: string): Segment[][] {
	const lines: Segment[][] = []
	let src = 0
	let line = 0
	let col = 0
	let name = 0
	for (const lineStr of mappings.split(';')) {
		const segs: Segment[] = []
		let genCol = 0
		for (const segStr of lineStr.split(',')) {
			if (!segStr) continue
			const fields: number[] = []
			let value = 0
			let shift = 0
			for (const ch of segStr) {
				const digit = B64.get(ch)!
				value += (digit & 31) << shift
				if (digit & 32) {
					shift += 5
					continue
				}
				fields.push(value & 1 ? -(value >>> 1) : value >>> 1)
				value = 0
				shift = 0
			}
			genCol += fields[0]
			if (fields.length >= 4) {
				src += fields[1]
				line += fields[2]
				col += fields[3]
				if (fields.length >= 5) name += fields[4]
				segs.push([genCol, src, line, col, fields.length >= 5 ? name : -1])
			}
		}
		lines.push(segs)
	}
	return lines
}

function loadMap(file: string): SourceMap | null {
	if (!fs.existsSync(file)) return null
	const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
	return { sources: raw.sources, names: raw.names, lines: decodeMappings(raw.mappings) }
}

function lookup(map: SourceMap, line: number, col: number) {
	const segs = map.lines[line]
	if (!segs || segs.length === 0) return null
	let lo = 0
	let hi = segs.length - 1
	let best = -1
	while (lo <= hi) {
		const mid = (lo + hi) >> 1
		if (segs[mid][0] <= col) {
			best = mid
			lo = mid + 1
		} else hi = mid - 1
	}
	if (best < 0) return null
	const [, src, srcLine, , name] = segs[best]
	return { source: map.sources[src], line: srcLine + 1, name: name >= 0 ? map.names[name] : null }
}

type ResolvedFrame = { label: string; bucket: string; isSrc: boolean }

// maps a profile node to its source function, cached per node
export function resolverFor(profile: CpuProfile, distDir: string): (n: ProfileNode) => ResolvedFrame {
	const maps = new Map<string, SourceMap | null>()
	const labels = new Map<number, ResolvedFrame>()
	return function resolve(n: ProfileNode) {
		let hit = labels.get(n.id)
		if (hit) return hit
		const { functionName, url, lineNumber, columnNumber } = n.callFrame
		const pathname = url ? new URL(url).pathname : ''
		if (!pathname) {
			hit = { label: functionName || '(native)', bucket: functionName.startsWith('(') ? functionName : '(native)', isSrc: false }
		} else {
			const file = path.join(distDir, pathname + '.map')
			if (!maps.has(file)) maps.set(file, loadMap(file))
			const map = maps.get(file)
			const pos = map ? lookup(map, lineNumber, columnNumber) : null
			if (!pos) {
				hit = { label: `${functionName || '(anon)'} ${pathname}`, bucket: pathname, isSrc: false }
			} else {
				const source = pos.source.replace(/^(\.\.\/)+/, '')
				const pkg = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/.exec(source)?.[1]
				hit = {
					label: `${pos.name ?? functionName ?? '(anon)'} ${source}:${pos.line}`,
					bucket: pkg ? `dep:${pkg}` : source,
					isSrc: !pkg,
				}
			}
		}
		labels.set(n.id, hit)
		return hit
	}
}

export async function summarizeProfile(profile: CpuProfile, opts: { distDir: string; top?: number }): Promise<string> {
	const top = opts.top ?? 80
	const resolve = resolverFor(profile, opts.distDir)
	const nodes = new Map(profile.nodes.map((n) => [n.id, n]))
	const parent = new Map<number, number>()
	for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)

	const timeByNode = new Map<number, number>()
	const samples = profile.samples ?? []
	const deltas = profile.timeDeltas ?? []
	for (let i = 0; i < samples.length; i++) {
		const dt = (deltas[i + 1] ?? 0) / 1000
		timeByNode.set(samples[i], (timeByNode.get(samples[i]) ?? 0) + dt)
	}

	const selfByBucket = new Map<string, number>()
	const selfByFn = new Map<string, number>()
	const inclBySrcFn = new Map<string, number>()
	let total = 0
	let idle = 0
	for (const [id, t] of timeByNode) {
		total += t
		const node = nodes.get(id)!
		if (node.callFrame.functionName === '(idle)') idle += t
		const self = resolve(node)
		selfByBucket.set(self.bucket, (selfByBucket.get(self.bucket) ?? 0) + t)
		selfByFn.set(self.label, (selfByFn.get(self.label) ?? 0) + t)
		const seen = new Set<string>()
		for (let cur: number | undefined = id; cur !== undefined; cur = parent.get(cur)) {
			const r = resolve(nodes.get(cur)!)
			if (!r.isSrc || seen.has(r.label)) continue
			seen.add(r.label)
			inclBySrcFn.set(r.label, (inclBySrcFn.get(r.label) ?? 0) + t)
		}
	}

	const fmt = (m: Map<string, number>, n: number) =>
		[...m]
			.sort((a, b) => b[1] - a[1])
			.slice(0, n)
			.map(([k, v]) => `${v.toFixed(1).padStart(9)}  ${k}`)
			.join('\n')
	return [
		`total ${total.toFixed(0)}ms, busy ${(total - idle).toFixed(0)}ms`,
		'',
		'== self time by package / source file ==',
		fmt(selfByBucket, 30),
		'',
		'== self time by function ==',
		fmt(selfByFn, top),
		'',
		'== inclusive time, src functions ==',
		fmt(inclBySrcFn, top),
		'',
	].join('\n')
}
