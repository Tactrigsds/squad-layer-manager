import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import * as SETTINGS from '@/models/settings.models'

import * as ZodUtils from './zod-utils'

// ZodUtils.schemaAtPath walks zod's internals to find the schema at a path, which is what lets the settings form hand a subtree
// its own editor. These pin the wrapper shapes it has to see through -- a zod upgrade that renames them would otherwise
// only surface as a JSON toggle silently disappearing from the page.
describe('ZodUtils.schemaAtPath', () => {
	it('walks through the wrappers that preserve an object shape', () => {
		const leaf = z.string()
		const schema = z.object({
			plain: z.object({ leaf }),
			defaulted: z.object({ leaf }).prefault({ leaf: '' }),
			optional: z.object({ leaf }).optional(),
			nullable: z.object({ leaf }).nullable(),
			// a one-way transform: the input side is the shape the settings drafts hold, so the walk follows it
			transformed: z
				.object({ leaf })
				.prefault({ leaf: '' })
				.transform((v) => v),
		})
		for (const key of ['plain', 'defaulted', 'optional', 'nullable', 'transformed']) {
			expect(ZodUtils.schemaAtPath(schema, [key, 'leaf']), key).toBe(leaf)
		}
	})

	it('returns a codec whole rather than descending into it', () => {
		const schema = z.object({ delay: ZodUtils.HumanTime })
		expect(ZodUtils.schemaAtPath(schema, ['delay'])).toBe(ZodUtils.HumanTime)
	})

	it('is undefined for paths it cannot statically address', () => {
		const schema = z.object({ list: z.array(z.object({ leaf: z.string() })), rec: z.record(z.string(), z.string()) })
		expect(ZodUtils.schemaAtPath(schema, ['missing'])).toBeUndefined()
		expect(ZodUtils.schemaAtPath(schema, ['list', 0, 'leaf'])).toBeUndefined()
		expect(ZodUtils.schemaAtPath(schema, ['rec', 'anything'])).toBeUndefined()
	})

	it('resolves every path the settings form offers a scoped JSON editor for', () => {
		const parsed = SETTINGS.parseGlobalSettings({})
		expect(parsed.success).toBe(true)
		for (const path of ['rbac', 'commands', 'playerGroupings', 'layerTable']) {
			const sub = ZodUtils.schemaAtPath(SETTINGS.GlobalSettingsSchema, path.split('.'))
			expect(sub, path).toBeDefined()
			// the editor writes back through encode, so each subtree must survive the decoded -> input round trip
			const decoded = path.split('.').reduce<any>((acc, key) => acc?.[key], parsed.data)
			expect(() => sub!.encode(decoded), path).not.toThrow()
		}
	})
})
