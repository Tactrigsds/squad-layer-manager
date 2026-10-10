import React from 'react'

import { GroupedRootFields, ObjectField } from '@/components/settings-form/engine'
import {
	AdvancedPathsContext,
	FormOptionsContext,
	type FormRoot,
	MessageVarsContext,
	NO_ADVANCED_PATHS,
	type NormalizedIssue,
	type Path,
	RootSchemaContext,
	SavedRootContext,
	type SchemaNode,
	useMessageVars,
	ValidationContext,
	WRITE_ACCESS_ALL,
	WriteAccessContext,
} from '@/components/settings-form/settings-form.helpers'
import type * as Rx from '@/lib/rxjs'
import type { SettingsGroup } from '@/lib/settings-groups'
import { z } from '@/lib/zod'
import type * as RBAC from '@/rbac.models'

export default function SettingsForm({
	schema,
	value$,
	reset$,
	onChange,
	saved,
	idPrefix = 'setting:',
	groups,
	priorityKeys,
	advancedPaths = NO_ADVANCED_PATHS,
	issues,
	writeAccess = WRITE_ACCESS_ALL,
}: {
	schema: z.ZodType
	value$: Rx.Observable<any> & { getValue: () => any }
	reset$: Rx.Subject<void>
	onChange: (next: any) => void
	// the last-saved baseline the draft was seeded from; powers each field's "reset to saved" button. May be
	// undefined while the settings are still loading.
	saved?: any
	// scopes field DOM ids / URL anchors; defaults to `setting:` (global settings). Server forms pass `setting:server:<id>:`
	idPrefix?: string
	// presentation-level grouping of the top-level keys (see settings-groups.ts); ungrouped keys render after the groups
	groups?: SettingsGroup[]
	// presentation-level ordering (ungrouped forms only): these top-level keys float to the front, in the given order,
	// with the rest following in schema order. Keeps the persisted shape untouched, same rationale as `groups`.
	priorityKeys?: string[]
	// dotted paths of the fields that render inside their section's collapsed "Advanced" disclosure (see settings-groups.ts)
	advancedPaths?: ReadonlySet<string>
	// schema issues for the current draft (input-shape safeParse); each leaf field displays the issues under its path
	issues?: readonly z.core.$ZodIssue[]
	// the user's write grant; fields with no overlap render read-only. Defaults to unrestricted.
	writeAccess?: RBAC.SettingsWriteAccess
}) {
	const rawJsonSchema = React.useMemo(() => z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as SchemaNode, [schema])
	// float any priorityKeys to the front of the root object's properties (insertion order drives render + reset order)
	const jsonSchema = React.useMemo(() => {
		const props: Record<string, SchemaNode> | undefined = rawJsonSchema?.properties
		if (!priorityKeys?.length || !props) return rawJsonSchema
		const ordered: Record<string, SchemaNode> = {}
		for (const k of priorityKeys) if (k in props) ordered[k] = props[k]
		for (const k of Object.keys(props)) if (!(k in ordered)) ordered[k] = props[k]
		return { ...rawJsonSchema, properties: ordered }
	}, [rawJsonSchema, priorityKeys])
	const rootPath = React.useMemo<Path>(() => [], [])
	const root = React.useMemo<FormRoot>(() => ({ value$, onChange }), [value$, onChange])
	const formOptions = React.useMemo(() => ({ idPrefix }), [idPrefix])
	const savedCtx = React.useMemo(() => ({ saved }), [saved])
	const messageVars = useMessageVars(value$)
	const normIssues = React.useMemo(
		() => (issues ?? []).map((i): NormalizedIssue => ({ path: i.path.map(String).join('.'), message: i.message })),
		[issues],
	)
	return (
		<FormOptionsContext.Provider value={formOptions}>
			<RootSchemaContext.Provider value={schema}>
				<AdvancedPathsContext.Provider value={advancedPaths}>
					<WriteAccessContext.Provider value={writeAccess}>
						<SavedRootContext.Provider value={savedCtx}>
							<MessageVarsContext.Provider value={messageVars}>
								<ValidationContext.Provider value={normIssues}>
									{groups ? (
										<GroupedRootFields
											node={jsonSchema}
											groups={groups}
											value$={value$}
											reset$={reset$}
											onChange={onChange}
											root={root}
										/>
									) : (
										<ObjectField
											node={jsonSchema}
											path={rootPath}
											value$={value$}
											reset$={reset$}
											onChange={onChange}
											root={root}
										/>
									)}
								</ValidationContext.Provider>
							</MessageVarsContext.Provider>
						</SavedRootContext.Provider>
					</WriteAccessContext.Provider>
				</AdvancedPathsContext.Provider>
			</RootSchemaContext.Provider>
		</FormOptionsContext.Provider>
	)
}
