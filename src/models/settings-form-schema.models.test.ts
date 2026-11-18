import { describe, expect, it } from 'vitest'

import { BUILTIN_PLUGINS } from '$root/plugins/builtins.server.ts'
import { z } from '@/lib/zod'
import * as FormSchema from '@/models/settings-form-schema.models'
import * as SETTINGS from '@/models/settings.models'

describe('jsonFallbackPaths', () => {
	it('finds only the known raw JSON fields in the settings schemas', () => {
		expect(FormSchema.jsonFallbackPaths(FormSchema.formSchema(SETTINGS.GlobalSettingsSchema))).toEqual([])
		// a bigint, which JSON Schema cannot represent
		expect(FormSchema.jsonFallbackPaths(FormSchema.formSchema(SETTINGS.ServerSettingsSchema))).toEqual([
			'updatesToSquadServerDisabled.by.userId',
		])
	})

	it.each(BUILTIN_PLUGINS.map((p) => [p.manifest.id, p.manifest.configSchema] as const))(
		'finds no raw JSON fields in the %s plugin config',
		(_id, configSchema) => {
			expect(FormSchema.jsonFallbackPaths(FormSchema.formSchema(configSchema))).toEqual([])
		},
	)
})

describe('formSchema', () => {
	const node = FormSchema.formSchema(
		z.object({
			nullableString: z.string().regex(/^\w+$/).nullable().meta({ title: 'T' }),
			nullableBoolean: z.boolean().nullable(),
			stringOrNumber: z.union([z.string(), z.number()]),
			nullableStringOrNumber: z.union([z.string(), z.number()]).nullable(),
		}),
	)
	const props = node.properties!
	const control = (key: string) => FormSchema.controlFor([key], props[key])

	it('splits type arrays into anyOf, leaving annotations on the outer node', () => {
		expect(props.nullableString).toMatchObject({ title: 'T', anyOf: [{ type: 'string', pattern: '^\\w+$' }, { type: 'null' }] })
		expect(props.nullableString).not.toHaveProperty('pattern')
		expect(props.nullableString).not.toHaveProperty('type')
	})

	it('dispatches unions of primitives to structural controls', () => {
		expect(control('nullableString')).toMatchObject({ kind: 'string', nullable: true })
		expect(control('nullableBoolean')).toMatchObject({ kind: 'boolean' })
		expect(control('stringOrNumber')).toMatchObject({ kind: 'string-or-number', nullable: false })
		expect(control('nullableStringOrNumber')).toMatchObject({ kind: 'string-or-number', nullable: true })
	})
})
