import * as Obj from '@/lib/object'

// shared by the settings GUI/JSON editors and the aggregated save panel: a leaf-level diff of two settings objects
// (in their encoded/input shape) keyed by dotted json path, plus value formatting for the change list.

export type SettingChange = { path: string; from: unknown; to: unknown }

// objects recurse; arrays and scalars are treated as leaves so a changed array shows as a single entry
export function diffSettings(from: any, to: any, path: string[] = [], out: SettingChange[] = []): SettingChange[] {
	const isPlainObj = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v)
	if (isPlainObj(from) && isPlainObj(to)) {
		for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
			diffSettings(from[key], to[key], [...path, key], out)
		}
	} else if (!Obj.deepEqual(from, to)) {
		out.push({ path: path.join('.'), from, to })
	}
	return out
}

export function formatChangeValue(v: unknown): string {
	if (v === undefined) return '(unset)'
	if (v === null) return 'null'
	if (typeof v === 'string') return v === '' ? '(empty)' : v
	if (typeof v === 'boolean' || typeof v === 'number') return String(v)
	const s = JSON.stringify(v)
	return s.length > 200 ? s.slice(0, 200) + '…' : s
}
