// `yaml` itself, plus the renderer the text-mode editors format with.
// WARNING: only import this from lazily-loaded (React.lazy'd) components -- it statically pulls in the whole `yaml`
// package, which we don't want in the initial/route chunk.
import type { Node, YAMLMap, YAMLSeq } from 'yaml'
import { Document, isMap, isNode, isPair, isScalar, isSeq, parseDocument, visit } from 'yaml'

export * from 'yaml'

// a collection renders on one line when its flow form fits in this many columns
const FLOW_WIDTH = 100

// Block YAML gives every scalar its own line, which spreads a filter's `{ type: column, column: Layer }` leaf over
// three. Compact collapses the collections that fit, keeping documents about a third the length of the block form;
// block is the one to reach for when a document is being diffed or read a line at a time.
export function stringifyDoc(value: unknown, compact = true): string {
	return render(new Document(value, { aliasDuplicateObjects: false }), compact)
}

// Comments keyed by dotted path into `value`, rendered as `#` lines directly above the key or list item at that path
// and read back from there by parseWithComments. A list item's segment is its index.
export type PathComments = Record<string, string>

export function stringifyDocWithComments(value: unknown, comments: PathComments, compact = true): string {
	const doc = new Document(value, { aliasDuplicateObjects: false })
	for (const [path, text] of Object.entries(comments)) {
		// a comment on a path that no longer exists has nowhere to render, so it drops out of the document here
		const target = commentTargetAtPath(doc.contents, path.split('.'))
		if (target) target.commentBefore = encodeComment(text)
	}
	return render(doc, compact)
}

// `yaml` appends a code frame to an error's message by default. The editors show errors beside the text, where the
// frame only repeats a line already on screen, so the first error is thrown without one. Its `pos` holds its span.
function parseOrThrow(text: string) {
	const doc = parseDocument(text, { prettyErrors: false })
	if (doc.errors[0]) throw doc.errors[0]
	return doc
}

export function parseValue(text: string): unknown {
	return parseOrThrow(text).toJS()
}

// Where a path into a document's value is written: the span of the value, or of its key when `key` is set. A path
// that leads nowhere resolves to the nearest node on it that exists, with `found` false.
export function locate(doc: Document, path: readonly PropertyKey[], opts?: { key?: boolean }) {
	let node: unknown = doc.contents
	let span = spanOf(node) ?? { from: 0, to: 0 }
	for (let i = 0; i < path.length; i++) {
		const segment = path[i]
		let next: unknown
		if (isMap(node)) {
			const pair = node.items.find((item) => (isScalar(item.key) ? item.key.value : item.key) === segment)
			if (!pair) return { ...span, found: false }
			const last = i === path.length - 1
			// a key with no value has no value node, so the key stands in for it
			next = last && opts?.key ? pair.key : (pair.value ?? pair.key)
		} else if (isSeq(node) && typeof segment === 'number') {
			next = node.items[segment]
			if (next === undefined) return { ...span, found: false }
		} else {
			return { ...span, found: false }
		}
		node = isPair(next) ? next.key : next
		span = spanOf(node) ?? span
	}
	return { ...span, found: true }
}

function spanOf(node: unknown) {
	if (!isNode(node) || !node.range) return null
	return { from: node.range[0], to: node.range[1] }
}

export function parseWithComments(text: string): { value: unknown; comments: PathComments } {
	const doc = parseOrThrow(text)
	const comments: PathComments = {}
	collectComments(doc.contents, [], comments)
	return { value: doc.toJS(), comments }
}

function render(doc: Document, compact: boolean): string {
	// An object graph that shares a reference twice -- a duplicated filter node shares its `args` with the
	// original -- otherwise renders as a YAML anchor and an alias. Nobody hand-editing a filter wants to
	// meet one, and the compact pass renders sub-nodes in isolation, where an alias whose anchor is on a
	// sibling cannot be resolved at all. (aliasDuplicateObjects is off on both Documents above for that reason.)
	if (compact) visit(doc, { Map: collapseIfShort, Seq: collapseIfShort })
	// the default 80-column fold breaks long scalars (a mustache template, a url) across lines
	return doc.toString({ lineWidth: 0 })
}

function collapseIfShort(_key: unknown, node: YAMLMap | YAMLSeq) {
	// the node's own comment renders on the line above it either way, so it neither blocks the flow form nor counts
	// against its width -- unlike a comment further down, which only block form has a line for
	const own = node.commentBefore
	node.commentBefore = null
	const flow = new Document(node).toString({ lineWidth: 0, collectionStyle: 'flow' }).trim()
	node.commentBefore = own
	// a newline survives flow style only for a block scalar or a comment, neither of which can be inlined at all
	if (flow.length > FLOW_WIDTH || flow.includes('\n')) return
	node.flow = true
	return visit.SKIP
}

// the node a comment at `path` renders above: a map entry's key, or a sequence item itself
function commentTargetAtPath(node: unknown, path: string[]): Node | undefined {
	let cur = node
	let target: Node | undefined
	for (const seg of path) {
		if (isMap(cur)) {
			const pair = cur.items.find((p) => isScalar(p.key) && String(p.key.value) === seg)
			if (!pair || !isNode(pair.key)) return undefined
			target = pair.key
			cur = pair.value
		} else if (isSeq(cur)) {
			const item = cur.items[Number(seg)]
			if (!isNode(item)) return undefined
			target = item
			cur = item
		} else return undefined
	}
	return target
}

// `ownConsumed` is set where the caller already took this node's commentBefore for itself: a sequence item's comment
// parses onto the item, which for a map item is the same slot the comment above its first entry lands in.
function collectComments(node: unknown, path: string[], out: PathComments, ownConsumed = false) {
	const leading = !ownConsumed && isNode(node) ? node.commentBefore : null
	if (isMap(node)) {
		node.items.forEach((pair, i) => {
			if (!isScalar(pair.key)) return
			const keyPath = [...path, String(pair.key.value)]
			// the comment above a nested map's first entry parses onto the map rather than onto that entry's key
			const raw = [i === 0 ? leading : null, pair.key.commentBefore].filter((c) => c != null).join('\n')
			const text = decodeComment(raw)
			if (text) out[keyPath.join('.')] = text
			collectComments(pair.value, keyPath, out)
		})
		return
	}
	if (!isSeq(node)) return
	node.items.forEach((item, i) => {
		if (!isNode(item)) return
		const itemPath = [...path, String(i)]
		const raw = [i === 0 ? leading : null, item.commentBefore].filter((c) => c != null).join('\n')
		const text = decodeComment(raw)
		if (text) out[itemPath.join('.')] = text
		collectComments(item, itemPath, out, true)
	})
}

// `yaml` emits the text after `#` verbatim and hands it back the same way, so the space after `#` is ours to add and
// strip. An empty line inside a comment renders bare, and comes back as a lone space.
function encodeComment(text: string): string {
	return text
		.split('\n')
		.map((line) => (line ? ' ' + line : ''))
		.join('\n')
}

function decodeComment(raw: string): string {
	return raw
		.split('\n')
		.map((line) => (line.startsWith(' ') ? line.slice(1) : line))
		.join('\n')
		.trim()
}
