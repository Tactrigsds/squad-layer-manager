// `yaml` itself, plus the compact renderer the text-mode editors format with.
// WARNING: only import this from lazily-loaded (React.lazy'd) components -- it statically pulls in the whole `yaml`
// package, which we don't want in the initial/route chunk.
import type { YAMLMap, YAMLSeq } from 'yaml'
import { Document, visit } from 'yaml'

export * from 'yaml'

// a collection renders on one line when its flow form fits in this many columns
const FLOW_WIDTH = 100

// Block YAML gives every scalar its own line, which spreads a filter's `{ type: column, column: Layer }` leaf over
// three. Collapsing the collections that fit keeps the documents about a third the length of the block form.
export function stringifyCompact(value: unknown): string {
	const doc = new Document(value)
	visit(doc, { Map: collapseIfShort, Seq: collapseIfShort })
	return doc.toString({ lineWidth: 0 })
}

function collapseIfShort(_key: unknown, node: YAMLMap | YAMLSeq) {
	const flow = new Document(node).toString({ lineWidth: 0, collectionStyle: 'flow' }).trim()
	// a newline survives flow style only for a block scalar, which can't be inlined at all
	if (flow.length > FLOW_WIDTH || flow.includes('\n')) return
	node.flow = true
	return visit.SKIP
}
