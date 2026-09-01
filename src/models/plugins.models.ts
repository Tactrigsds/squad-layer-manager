import * as D from 'drizzle-orm/sqlite-core'
import { z } from 'zod'

import * as CMD from '@/models/command.models'
import type * as RBAC from '@/rbac.models'
import type { MigrationDriver } from '@/server/migrate'

// Plugins are trusted, in-process extensions. A plugin directory under plugins/ holds a side-effect-free
// manifest (plugin.ts, the module everything else imports), a server entry (server.ts) whose activate()
// runs when the plugin starts, and optionally a client entry (client.tsx) and migrations (migrations.ts).
// The runtime lives in src/systems/plugins.server.ts / plugins.client.ts.

/**
 * The slm/* surface this build provides. A manifest declares the range it needs as `apiVersion`.
 *
 * Pre-1.0, and semver's 0.x rule shifts every component one place left: the minor carries breaking
 * changes and additions move the patch. `pnpm api:report` enforces that against the report diff.
 */
export const API_VERSION = { major: 0, minor: 5, patch: 0 }

/** `API_VERSION` as a semver string, for the report header and anything shown to an admin. */
export function formatApiVersion(): string {
	return `${API_VERSION.major}.${API_VERSION.minor}.${API_VERSION.patch}`
}

// ids double as table/permission namespace segments, so the alphabet stays small
export const PluginIdSchema = z
	.string()
	.regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, 'lowercase kebab-case')
	.max(48)
export type PluginId = z.infer<typeof PluginIdSchema>

export interface Manifest<ConfigSchema extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> {
	id: PluginId
	name: string
	version: string
	// the slm API versions this plugin works against, e.g. '^0.1' or '^1.2'
	apiVersion: string
	description: string
	configSchema: ConfigSchema
}

const ManifestFieldsSchema = z.object({
	id: PluginIdSchema,
	name: z.string().min(1),
	version: z.string().regex(/^\d+\.\d+\.\d+$/),
	apiVersion: z.string().regex(/^\^\d+(\.\d+){0,2}$/),
	description: z.string(),
})

/**
 * Validates and freezes a plugin's manifest. Call it at the top level of plugin.ts and default-export
 * the result: it is the module every other half of the plugin imports, and the host reads it to learn
 * the plugin's identity and config schema without loading its server bundle.
 */
export function definePlugin<M extends Manifest<z.ZodObject<any>>>(manifest: M): M {
	const { configSchema, ...fields } = manifest
	ManifestFieldsSchema.parse(fields)
	if (!(configSchema instanceof z.ZodObject)) {
		throw new Error(`plugin ${manifest.id}: configSchema must be a z.object(...)`)
	}
	return Object.freeze(manifest)
}

/**
 * The telemetry scope for a plugin, `plugin:<id>`, or `plugin:<id>:<submodule>`. It names the otel
 * tracer and log scope, prefixes every spanOp name, and is the `slm.module.name` on the plugin's log
 * records, so the `plugin:` prefix is the one thing separating a plugin's telemetry from the host's.
 * The host builds it; a plugin reaches its module through `ctx.module` rather than naming itself.
 */
export function moduleName(pluginId: PluginId, submodule?: string): string {
	return submodule ? `plugin:${pluginId}:${submodule}` : `plugin:${pluginId}`
}

/**
 * Whether this build satisfies a manifest's caret range ('^0.1', '^1.2', '^1.2.3'). Checked before
 * activation. Follows semver's 0.x rule, so `^0.1` admits 0.1.x and nothing else: below 1.0 a minor
 * bump is breaking, and accepting it here is what the check exists to prevent.
 */
export function satisfiesApiVersion(range: string): boolean {
	const match = /^\^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range)
	if (!match) return false
	const major = Number(match[1])
	const minor = match[2] === undefined ? 0 : Number(match[2])
	const patch = match[3] === undefined ? 0 : Number(match[3])
	if (major !== API_VERSION.major) return false
	if (major === 0 && minor !== API_VERSION.minor) return false
	if (minor > API_VERSION.minor) return false
	return minor < API_VERSION.minor || patch <= API_VERSION.patch
}

export type Config<M extends Manifest<any>> = z.infer<M['configSchema']>
export type ConfigInput<M extends Manifest<any>> = z.input<M['configSchema']>

// ---- runtime state, as served to the client ----

export const StatusSchema = z.enum(['inactive', 'activating', 'active', 'stopping', 'errored'])
export type Status = z.infer<typeof StatusSchema>

export const SourceSchema = z.enum(['builtin', 'directory', 'url'])
export type Source = z.infer<typeof SourceSchema>

// -------- plugin-declared permissions --------

/**
 * An action a plugin defines for itself, so an admin can grant it to a role. Only the two scopes that need no
 * bespoke arguments: a plugin cannot introduce a comparator ("up to N") or a path-restricted grant, both of
 * which the permission matcher has to understand specifically.
 */
export type PermissionDeclaration = {
	scope: 'global' | 'server'
	// one line, shown next to the checkbox in the role editor
	description: string
}

export type PermissionInfo = PermissionDeclaration & { name: string }

export const PermissionInfoSchema = z.object({
	name: z.string(),
	scope: z.enum(['global', 'server']),
	description: z.string(),
})

// What registerPermissions hands back: one builder per declared action, asking for a server only where the
// declaration said the action is about one.
export type PermissionBuilders<D extends Record<string, PermissionDeclaration>> = {
	[K in keyof D]: D[K]['scope'] extends 'server'
		? (serverId: string) => RBAC.Permission<'plugin:action'>
		: () => RBAC.Permission<'plugin:action'>
}

export const RuntimeInfoSchema = z.object({
	id: PluginIdSchema,
	name: z.string(),
	description: z.string(),
	version: z.string(),
	// the slm api range the manifest declares, e.g. '^0.1'. Checked against API_VERSION before activation
	apiVersion: z.string(),
	enabled: z.boolean(),
	status: StatusSchema,
	// what put the plugin in 'errored', for the settings UI
	error: z.string().nullable(),
	hasClient: z.boolean(),
	// the in-game commands this plugin contributes, for the commands page. Empty while it is not active, since a
	// stopped plugin's command does not answer
	commands: z.array(CMD.PluginCommandInfoSchema).prefault([]),
	permissions: z.array(PermissionInfoSchema).prefault([]),
	source: SourceSchema,
	// where a url-installed package was fetched from, and what refresh re-fetches
	sourceUrl: z.string().nullable(),
	// urls the browser imports a packaged plugin's modules from, each carrying its bundle's hash. Both
	// null for a builtin, whose modules are in the app bundle; clientEntry is null for a plugin with no
	// client. A change to clientEntry is an upgrade the running page cannot pick up -- ESM never
	// unloads -- so the client asks for a reload.
	manifestEntry: z.string().nullable(),
	clientEntry: z.string().nullable(),
})
export type RuntimeInfo = z.infer<typeof RuntimeInfoSchema>

// What an uninstall leaves behind: a plugins row (config + enabled) and the plugin's own tables, kept so
// reinstalling restores its settings and data. Nothing reclaims them, so an admin has to ask.
export const LeftoverDataSchema = z.object({
	pluginId: PluginIdSchema,
	tables: z.array(z.object({ name: z.string(), rows: z.number() })),
	migrations: z.number(),
})
export type LeftoverData = z.infer<typeof LeftoverDataSchema>

// ---- packages: a plugin as it exists in the plugins directory ----

// A plugin directory holds plugin.json plus the prebuilt esm bundles it names. The bundles resolve
// `slm/*` and the shared packages (rxjs, zod, drizzle-orm, react) through the host rather than
// bundling their own: see src/systems/plugin-api-registry.server.ts.
export const PackageManifestSchema = z.object({
	id: PluginIdSchema,
	name: z.string().min(1),
	version: z.string().regex(/^\d+\.\d+\.\d+$/),
	apiVersion: z.string().regex(/^\^\d+(\.\d+){0,2}$/),
	description: z.string().prefault(''),
	// the isomorphic manifest module, mirroring an in-repo plugin.ts: `export default definePlugin(...)`.
	// Both halves import it, which is how the settings form gets a config schema for a plugin that is
	// inactive, or has no client at all, without evaluating its server bundle.
	manifest: z.string().prefault('plugin.mjs'),
	server: z.string().prefault('server.mjs'),
	client: z.string().optional(),
})
export type PackageManifest = z.infer<typeof PackageManifestSchema>

export const PACKAGE_MANIFEST_FILE = 'plugin.json'
// written beside a package SLM fetched, so refresh knows where to look again. A directory without
// one was put there by hand, and SLM only ever reads it.
export const INSTALL_RECORD_FILE = '.slm-install.json'

export const InstallRecordSchema = z.object({
	sourceUrl: z.url(),
	installedAt: z.number(),
	// relative path -> sha256, recorded at fetch time and not read back by anything yet. A record of
	// what this install pulled down, for an admin comparing it against the source by hand; not a
	// signature, and not checked on refresh, which overwrites whatever the url serves now.
	files: z.record(z.string(), z.string()),
})
export type InstallRecord = z.infer<typeof InstallRecordSchema>

// ---- persistence owned by a plugin ----

// every table a plugin creates carries this prefix; the migration runner rejects DDL outside it
/** The table-name prefix a plugin owns: `p_<id>_`, with dashes as underscores. */
export function tablePrefix(pluginId: PluginId): string {
	return `p_${pluginId.replaceAll('-', '_')}_`
}

// same contract as a core TsMigration (see src/server/migrate.ts): raw driver, runner owns the
// transaction, frozen in time. Applied at activation rather than at boot, keyed per plugin.
export type PluginMigration = {
	// zero-padded prefix + description, e.g. '0001_init'; ordered lexicographically per plugin
	name: string
	up: (db: MigrationDriver) => void | Promise<void>
}

// named rather than inferred so the API report prints `TableFactory` instead of drizzle's six
// kilobytes of expanded SQLiteTableWithColumns
export interface TableFactory {
	table: <Cols extends Record<string, D.SQLiteColumnBuilderBase>>(
		name: string,
		columns: Cols,
	) => ReturnType<typeof D.sqliteTable<string, Cols>>
	/**
	 * The prefixed name `table(name, ...)` would produce, for the raw sql in migrations. Spell the
	 * unprefixed name out there rather than reaching into the schema module: a migration is frozen in
	 * time, and a later rename must not reach back and change what it did.
	 */
	name: (name: string) => string
}

/**
 * Drizzle table builder scoped to the plugin: every name it produces carries the `p_<id>_` prefix, and
 * the migration runner rejects DDL outside it.
 */
export function defineTables(manifest: { id: PluginId }): TableFactory {
	const prefix = tablePrefix(manifest.id)
	return {
		table: (name, columns) => D.sqliteTable(prefix + name, columns),
		name: (name) => prefix + name,
	}
}

// -------- config field controls --------

/**
 * The JSON Schema key a config field names its control with. settings-form.tsx picks its own controls by
 * setting path, which a plugin has no way to reach; this survives z.toJSONSchema, so a plugin's schema can
 * ask for one by declaring it.
 */
export const FIELD_CONTROL_KEY = 'x-slm-field'

export const FIELD_CONTROLS = [
	'filter-id',
	'filter-ids',
	'server-id',
	'server-ids',
	'discord-channel-id',
	'discord-channel-ids',
	'multiline',
] as const
export type FieldControl = (typeof FIELD_CONTROLS)[number]

/** Reads the control a JSON Schema node asks for, or undefined for an ordinary field. */
export function fieldControl(node: unknown): FieldControl | undefined {
	const declared = (node as Record<string, unknown> | null | undefined)?.[FIELD_CONTROL_KEY]
	return FIELD_CONTROLS.includes(declared as FieldControl) ? (declared as FieldControl) : undefined
}

/**
 * Every value a config holds under fields declaring `control`, with the dotted path it sits at.
 *
 * Driven off the JSON Schema rather than the zod schema because that is what survives to the settings form,
 * so what this finds and what renders as a picker cannot drift apart. The path is the one the settings anchor
 * `setting:plugin:<id>:<path>` uses, so a caller can link straight to the field.
 */
export function configFieldValues(schema: unknown, config: unknown, control: FieldControl): { path: string; value: string }[] {
	const out: { path: string; value: string }[] = []
	const walk = (node: unknown, value: unknown, path: string) => {
		if (node === null || typeof node !== 'object') return
		const obj = node as Record<string, unknown>
		if (fieldControl(obj) === control) {
			if (typeof value === 'string') {
				if (value) out.push({ path, value })
			} else if (Array.isArray(value)) {
				value.forEach((entry, i) => {
					if (typeof entry === 'string' && entry) out.push({ path: `${path}[${i}]`, value: entry })
				})
			}
			return
		}
		const properties = obj.properties as Record<string, unknown> | undefined
		if (properties && value !== null && typeof value === 'object' && !Array.isArray(value)) {
			for (const [key, child] of Object.entries(properties)) {
				walk(child, (value as Record<string, unknown>)[key], path ? `${path}.${key}` : key)
			}
			return
		}
		if (obj.items && Array.isArray(value)) {
			value.forEach((entry, i) => walk(obj.items, entry, `${path}[${i}]`))
		}
	}
	walk(schema, config, '')
	return out
}

const withControl = <S extends z.ZodType>(schema: S, control: FieldControl): S => schema.meta({ [FIELD_CONTROL_KEY]: control }) as S

/**
 * Config fields that render as one of SLM's pickers instead of a text box. Each stores what its name says:
 * a filter entity id, a managed server id, a Discord channel id.
 *
 * The value is still a plain string (or array of them), so a config written by hand or through the YAML
 * editor is unaffected, and an id whose target has since been deleted still round-trips.
 */
export const Fields = {
	filterId: () => withControl(z.string(), 'filter-id'),
	filterIds: () => withControl(z.array(z.string()), 'filter-ids'),
	serverId: () => withControl(z.string(), 'server-id'),
	serverIds: () => withControl(z.array(z.string()), 'server-ids'),
	discordChannelId: () => withControl(z.string(), 'discord-channel-id'),
	discordChannelIds: () => withControl(z.array(z.string()), 'discord-channel-ids'),
	/** a string edited in a textarea rather than a one-line input, for message templates and the like */
	multilineText: () => withControl(z.string(), 'multiline'),
}
