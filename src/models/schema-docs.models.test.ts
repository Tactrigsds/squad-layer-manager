import { describe, expect, test } from 'vitest'

import { z } from '@/lib/zod'
import * as SDoc from '@/models/schema-docs.models'
import * as SETTINGS from '@/models/settings.models'

type Node = Record<string, any>

// The dotted paths of every rendered field without a label, and of every discriminated union without a name for
// each branch. Record keys and array indices are data, so they appear as `*`.
function undocumented(root: Node): string[] {
	const missing: string[] = []
	const walk = (node: Node | undefined, path: string[], skip?: string) => {
		if (!node || typeof node !== 'object' || SDoc.read(node)?.opaque) return
		const discriminator = unionDiscriminator(node)
		for (const branch of [...(node.anyOf ?? []), ...(node.oneOf ?? [])]) walk(branch, path, discriminator)
		if (discriminator) {
			const options = SDoc.read(node)?.options ?? {}
			for (const branch of node.oneOf ?? node.anyOf) {
				const value = branch.properties[discriminator].const
				if (!options[value]) missing.push([...path, `(${discriminator}=${value})`].join('.'))
			}
		}
		for (const [key, child] of Object.entries<Node>(node.properties ?? {})) {
			if (key === skip || (path.length === 0 && key === SETTINGS.COMMENTS_KEY)) continue
			const childPath = [...path, key]
			if (!SDoc.read(child)?.label) missing.push(childPath.join('.'))
			walk(child, childPath)
		}
		if (node.items) walk(node.items, [...path, '*'])
		if (node.additionalProperties && typeof node.additionalProperties === 'object') walk(node.additionalProperties, [...path, '*'])
	}
	walk(root, [])
	return [...new Set(missing)]
}

function unionDiscriminator(node: Node): string | undefined {
	const branches: Node[] | undefined = node.oneOf ?? node.anyOf
	if (!branches || branches.length < 2) return undefined
	const shared = Object.keys(branches[0].properties ?? {}).filter((key) => branches.every((b) => b.properties?.[key]?.const !== undefined))
	return shared[0]
}

describe('settings schema docs', () => {
	for (const [name, schema] of [
		['global', SETTINGS.GlobalSettingsSchema],
		['server', SETTINGS.ServerSettingsSchema],
	] as const) {
		test(`every ${name} setting has a label`, () => {
			const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Node
			expect(undocumented(json)).toEqual([])
		})
	}
})
