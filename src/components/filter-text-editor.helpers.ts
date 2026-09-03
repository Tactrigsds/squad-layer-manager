// The text mirror renders a node's comment as a `#` line above the node, the way the settings YAML editor does,
// rather than as the `comment:` field the tree stores it in. Nothing outside the buffer changes shape.

import * as Obj from '@/lib/object-utils'
import * as Yaml from '@/lib/yaml'

// takes unknown because the format and compact-switch paths re-render whatever is in the buffer, valid or not
export function stringifyWithNodeComments(node: unknown, compact: boolean): string {
	const comments: Yaml.PathComments = {}
	return Yaml.stringifyDocWithComments(lift(node, [], comments), comments, compact)
}

export function parseWithNodeComments(text: string): unknown {
	const { value, comments } = Yaml.parseWithComments(text)
	for (const [path, comment] of Object.entries(comments)) {
		// a `#` line supersedes a `comment:` field typed into the buffer by hand. The value was parsed for this
		// call, so it is ours to write into
		const node = nodeAtPath(value, path.split('.'))
		if (node) node.comment = comment
	}
	return value
}

function lift(node: unknown, path: string[], out: Yaml.PathComments): unknown {
	if (!Obj.isPlainObject(node)) return node
	const rest = { ...node }
	// the root node has no line of its own to sit above, so its comment goes above the first key it renders
	const key = path.length > 0 ? path.join('.') : Object.keys(rest).find((k) => k !== 'comment')
	// anything a `#` line cannot carry stays where it is, for the schema to reject
	if (typeof rest.comment === 'string' && rest.comment !== '' && key) {
		out[key] = rest.comment
		delete rest.comment
	}
	if (Array.isArray(rest.children)) {
		rest.children = rest.children.map((child, i) => lift(child, [...path, 'children', String(i)], out))
	}
	return rest
}

// The node a comment renders above. A path that runs past a node into its own keys -- `type`, or `children.0.args`,
// where the comment was hand-written above a key of a node in block form -- belongs to the node those keys are on.
function nodeAtPath(root: unknown, segments: string[]): Record<string, unknown> | undefined {
	let node = root
	for (let i = 0; i + 1 < segments.length && segments[i] === 'children'; i += 2) {
		const children = Obj.isPlainObject(node) ? node.children : undefined
		if (!Array.isArray(children)) return undefined
		node = children[Number(segments[i + 1])]
	}
	return Obj.isPlainObject(node) ? node : undefined
}
