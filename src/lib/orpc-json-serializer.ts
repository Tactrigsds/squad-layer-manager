// A drop-in for oRPC's StandardRPCJsonSerializer that writes the same `json` and `meta`, so the wire format and the
// stock deserializer on the other end are unchanged.
//
// The stock serialize copies every object and array it visits and allocates a fresh path array per property, which
// costs ~3x the JSON.stringify that follows it. This one keeps one mutable path, allocates only when it records a meta
// entry, and returns subtrees that need no encoding by reference, copying an object or array only once a child of it
// changed. A payload of plain JSON values comes back as the same reference.
//
// Custom serializers are not supported.
import {
	STANDARD_RPC_JSON_SERIALIZER_BUILT_IN_TYPES as T,
	type StandardRPCJsonSerialized,
	type StandardRPCJsonSerializedMetaItem,
	StandardRPCJsonSerializer,
} from '@orpc/client/standard'

type Path = (string | number)[]
type Meta = StandardRPCJsonSerializedMetaItem[]

export class FastRPCJsonSerializer extends StandardRPCJsonSerializer {
	override serialize(
		data: unknown,
		segments: Path = [],
		meta: Meta = [],
		maps: Path[] = [],
		blobs: Blob[] = [],
	): StandardRPCJsonSerialized {
		return [encode(data, [...segments], meta, maps, blobs), meta, maps, blobs]
	}
}

function encode(data: unknown, path: Path, meta: Meta, maps: Path[], blobs: Blob[]): unknown {
	switch (typeof data) {
		case 'string':
		case 'boolean':
		case 'undefined':
			return data
		case 'number':
			if (data !== data) {
				meta.push([T.NAN, ...path])
				return null
			}
			return data
		case 'bigint':
			meta.push([T.BIGINT, ...path])
			return data.toString()
		case 'object':
			break
		default:
			return data
	}
	if (data === null) return null

	if (Array.isArray(data)) {
		let out: unknown[] | undefined
		const len = data.length
		const depth = path.length
		path.push(0)
		for (let i = 0; i < len; i++) {
			const v = data[i]
			let encoded: unknown
			if (v === undefined) {
				// a hole is left for JSON.stringify to write as null, as the stock serializer does; plugin results carry them
				if (!(i in data)) continue
				path[depth] = i
				meta.push([T.UNDEFINED, ...path])
				encoded = null
			} else if (typeof v === 'object' || typeof v === 'bigint' || typeof v === 'number') {
				path[depth] = i
				encoded = encode(v, path, meta, maps, blobs)
			} else {
				encoded = v
			}
			if (out) out[i] = encoded
			else if (encoded !== v) {
				out = data.slice(0, i)
				out[i] = encoded
			}
		}
		path.pop()
		// a trailing hole is never assigned
		if (out) out.length = len
		return out ?? data
	}

	const proto = Object.getPrototypeOf(data)
	if (proto === Object.prototype || proto === null || !proto.constructor) {
		const obj = data as Record<string, unknown>
		let out: Record<string, unknown> | undefined
		const depth = path.length
		path.push('')
		for (const k in obj) {
			const v = obj[k]
			let encoded: unknown
			if (k === 'toJSON' && typeof v === 'function') {
				if (!out) out = copyKeysBefore(obj, k)
				continue
			}
			if (typeof v === 'object' || typeof v === 'bigint' || typeof v === 'number') {
				path[depth] = k
				encoded = encode(v, path, meta, maps, blobs)
			} else {
				encoded = v
			}
			if (out) out[k] = encoded
			else if (encoded !== v) {
				out = copyKeysBefore(obj, k)
				out[k] = encoded
			}
		}
		path.pop()
		return out ?? obj
	}

	if (data instanceof Date) {
		meta.push([T.DATE, ...path])
		return Number.isNaN(data.getTime()) ? null : data.toISOString()
	}
	if (data instanceof Blob) {
		maps.push([...path])
		blobs.push(data)
		return data
	}
	if (data instanceof Set) {
		const json = encode(Array.from(data), path, meta, maps, blobs)
		meta.push([T.SET, ...path])
		return json
	}
	if (data instanceof Map) {
		const json = encode(Array.from(data.entries()), path, meta, maps, blobs)
		meta.push([T.MAP, ...path])
		return json
	}
	if (data instanceof URL) {
		meta.push([T.URL, ...path])
		return data.toString()
	}
	if (data instanceof RegExp) {
		meta.push([T.REGEXP, ...path])
		return data.toString()
	}
	return data
}

function copyKeysBefore(obj: Record<string, unknown>, stop: string): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const k in obj) {
		if (k === stop) break
		if (k === 'toJSON' && typeof obj[k] === 'function') continue
		out[k] = obj[k]
	}
	return out
}
