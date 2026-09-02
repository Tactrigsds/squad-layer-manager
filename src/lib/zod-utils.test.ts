import { describe, expect, it } from 'vitest'

import * as SETTINGS from '@/models/settings.models'

import * as ZodUtils from './zod-utils'
import { z } from './zod.ts'

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

// The point of internedEnum/internedLiteral is memory, which `===` cannot observe: JS string equality is by value,
// so a fresh copy and the canonical instance compare equal either way. What is testable is that the output is
// unchanged and that the schema stays the class `z.discriminatedUnion` needs to read a discriminator out of.
describe('ZodUtils.internedEnum / internedLiteral', () => {
	it('parses and rejects exactly as the plain schemas do', () => {
		const interned = ZodUtils.internedEnum(['Rifleman', 'Medic'])
		expect(interned.parse('Medic')).toBe('Medic')
		expect(interned.safeParse('Sniper').success).toBe(false)
		expect(ZodUtils.internedLiteral('PLAYER_DIED').parse('PLAYER_DIED')).toBe('PLAYER_DIED')
		expect(ZodUtils.internedLiteral('PLAYER_DIED').safeParse('OTHER').success).toBe(false)
	})

	it('keeps the enum an enum, so .options survives', () => {
		expect(ZodUtils.internedEnum(['a', 'b']).options).toEqual(['a', 'b'])
	})

	// transform() would make this a ZodPipe and the union would no longer find its discriminator
	it('stays usable as a discriminated union discriminator', () => {
		const schema = z.discriminatedUnion('type', [
			z.object({ type: ZodUtils.internedLiteral('PLAYER_DIED'), victim: z.string() }),
			z.object({ type: ZodUtils.internedLiteral('PLAYER_WOUNDED'), victim: z.string() }),
		])
		expect(schema.parse({ type: 'PLAYER_WOUNDED', victim: 'x' })).toEqual({ type: 'PLAYER_WOUNDED', victim: 'x' })
		expect(schema.safeParse({ type: 'NOT_AN_EVENT' }).success).toBe(false)
	})

	it('hands back one instance per value rather than one per parse', () => {
		const interned = ZodUtils.internedEnum(['Rifleman', 'Medic'])
		// the canonical instance is the schema's own option, which is what makes the table bounded by the value set
		const parsed = [interned.parse(JSON.parse('"Medic"')), interned.parse(JSON.parse('"Medic"'))]
		const distinct = new Set(parsed)
		expect(distinct.size).toBe(1)
		expect(parsed[0]).toBe(interned.options[1])
	})
})
