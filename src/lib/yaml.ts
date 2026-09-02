// `yaml` itself, plus the renderer the text-mode editors format with.
// WARNING: only import this from lazily-loaded (React.lazy'd) components -- it statically pulls in the whole `yaml`
// package, which we don't want in the initial/route chunk.
import type { Scalar, YAMLMap, YAMLSeq } from 'yaml'
import { Document, isMap, isScalar, parseDocument, visit } from 'yaml'

export * from 'yaml'

// a collection renders on one line when its flow form fits in this many columns
const FLOW_WIDTH = 100

// Block YAML gives every scalar its own line, which spreads a filter's `{ type: column, column: Layer }` leaf over
// three. Compact collapses the collections that fit, keeping documents about a third the length of the block form;
// block is the one to reach for when a document is being diffed or read a line at a time.
export function stringifyDoc(value: unknown, compact = true): string {
	return render(new Document(value, { aliasDuplicateObjects: false }), compact)
}

// Comments keyed by dotted path into `value`, rendered as `#` lines directly above the key at that path and read back
// from there by parseWithComments. Only map keys are addressable: a comment above a list item has no path the settings
// GUI can anchor, so it is not read back.
export type PathComments = Record<string, string>

export function stringifyDocWithComments(value: unknown, comments: PathComments, compact = true): string {
	const doc = new Document(value, { aliasDuplicateObjects: false })
	for (const [path, text] of Object.entries(comments)) {
		// a comment on a key that no longer exists has nowhere to render, so it drops out of the document here
		const key = keyAtPath(doc.contents, path.split('.'))
		if (key) key.commentBefore = encodeComment(text)
	}
	return render(doc, compact)
}

export function parseWithComments(text: string): { value: unknown; comments: PathComments } {
	const doc = parseDocument(text)
	if (doc.errors.length > 0) throw doc.errors[0]
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
	const flow = new Document(node).toString({ lineWidth: 0, collectionStyle: 'flow' }).trim()
	// a newline survives flow style only for a block scalar or a comment, neither of which can be inlined at all
	if (flow.length > FLOW_WIDTH || flow.includes('\n')) return
	node.flow = true
	return visit.SKIP
}

function keyAtPath(node: unknown, path: string[]): Scalar | undefined {
	let cur = node
	let key: Scalar | undefined
	for (const seg of path) {
		if (!isMap(cur)) return undefined
		const pair = cur.items.find((p) => isScalar(p.key) && String(p.key.value) === seg)
		if (!pair) return undefined
		key = pair.key as Scalar
		cur = pair.value
	}
	return key
}

function collectComments(node: unknown, path: string[], out: PathComments) {
	if (!isMap(node)) return
	node.items.forEach((pair, i) => {
		if (!isScalar(pair.key)) return
		const keyPath = [...path, String(pair.key.value)]
		// the comment above a nested map's first entry parses onto the map rather than onto that entry's key
		const raw = [i === 0 ? node.commentBefore : null, pair.key.commentBefore].filter((c) => c != null).join('\n')
		const text = decodeComment(raw)
		if (text) out[keyPath.join('.')] = text
		collectComments(pair.value, keyPath, out)
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
