import fs from 'node:fs'
import path from 'node:path'
import type { z } from 'zod'
import * as Paths from '../../paths.ts'
import * as Env from './env.ts'

// Renders the example env files from the schema in env.ts, so what someone copies can't drift from what the
// app actually reads. Regenerated on every dev boot (see main.ts) rather than by a script nobody remembers to
// run, which means a var added without example metadata still shows up in the diff.
//
// There are two audiences, and they want different files: someone standing up an install (.env.example) and
// someone running the app from a checkout (.env.example.dev). A var's metadata describes the deployment file,
// and its `dev` key overrides that where the two diverge (see EnvExampleMeta).

export type Audience = 'deployment' | 'dev'

export const PATHS: Record<Audience, string> = {
	deployment: path.join(Paths.PROJECT_ROOT, '.env.example'),
	dev: path.join(Paths.PROJECT_ROOT, '.env.example.dev'),
}

const COMMENT_WIDTH = 110

const HEADERS: Record<Audience, string[]> = {
	deployment: [
		'The environment SLM runs on. Copy this to .env, which is the file a docker install points env_file at',
		'(see docker-compose.yaml). Anything in here can be passed as a real environment variable instead, which',
		'takes precedence.',
		'',
		'Fill in the vars left uncommented. Everything commented out is optional, and shows the default it falls',
		'back to -- an empty one has no default, so uncommenting a line as-is never changes what the app does.',
		'',
		'Running the app from a checkout rather than installing it? Use .env.example.dev.',
	],
	dev: [
		'The environment SLM runs on, for a local checkout (`pnpm server:dev`). Copy this to .env.',
		'',
		'Fill in the vars left uncommented. Everything commented out is optional, and shows the default it falls',
		'back to -- an empty one has no default, so uncommenting a line as-is never changes what the app does.',
		'',
		'This leaves out what only an install has to care about (backups and the sftp target they upload to). See',
		'.env.example for those, or src/server/env.ts for everything.',
	],
}

const GENERATED_BY = 'Generated from src/server/env.ts on every dev boot -- edit the schema there, not this file.'

export function build(audience: Audience): string {
	const lines: string[] = [GENERATED_BY, '', ...HEADERS[audience]].map(comment)
	for (const [groupName, group] of Object.entries(Env.groups)) {
		const rendered = Object.entries(group as Record<string, z.ZodType>)
			.map(([name, schema]) => renderVar(name, schema, audience))
			.filter(v => v !== undefined)
		if (rendered.length === 0) continue

		const meta = Env.groupMeta[groupName as keyof typeof Env.groups]
		lines.push('', section(meta.title))
		if (meta.description) lines.push(...wrap(meta.description).map(comment), '')
		lines.push(rendered.join('\n\n'))
	}
	return lines.join('\n') + '\n'
}

// returns the files whose contents changed, so the caller can say which. Nothing in the app reads these back,
// so an example that fails to write is never worth interrupting a boot for.
export function write(): { changed: string[] } {
	const changed: string[] = []
	for (const audience of Object.keys(PATHS) as Audience[]) {
		const filePath = PATHS[audience]
		const content = build(audience)
		let existing: string | undefined
		try {
			existing = fs.readFileSync(filePath, 'utf8')
		} catch {
			// not written yet
		}
		if (existing === content) continue
		fs.writeFileSync(filePath, content)
		changed.push(path.basename(filePath))
	}
	return { changed }
}

function renderVar(name: string, schema: z.ZodType, audience: Audience): string | undefined {
	const meta = schema.meta()
	const example = meta?.envExample ?? {}
	// an entry describes the deployment file; the dev file takes that and applies whatever `dev` overrides
	const entry = audience === 'dev' ? { ...example, ...example.dev } : example
	// a var the schema won't accept as undefined has to be filled in, so it's written uncommented
	const include = entry.include ?? (schema.isOptional() ? 'commented' : 'set')
	if (include === 'omit') return undefined

	const assignment = `${name}=${entry.value ?? format(defaultValue(schema))}`
	const description = (audience === 'dev' ? example.dev?.description : undefined) ?? meta?.description
	const lines = description ? description.split('\n').flatMap(wrap).map(comment) : []
	lines.push(include === 'commented' ? comment(assignment) : assignment)
	return lines.join('\n')
}

type Def = { type: string; innerType?: z.ZodType; in?: z.ZodType; defaultValue?: unknown }

// the value a var falls back to when unset, unwrapped from whatever the schema is wrapped in. .default()
// holds an output value and .prefault() an input one, but for env vars (strings in, anything out) both
// stringify to the same thing.
function defaultValue(schema: z.ZodType): unknown {
	const def = schema._zod.def as Def
	switch (def.type) {
		case 'default':
		case 'prefault':
			return def.defaultValue
		case 'optional':
		case 'nullable':
		case 'nonoptional':
		case 'readonly':
			return def.innerType && defaultValue(def.innerType)
		case 'pipe':
			return def.in && defaultValue(def.in)
		default:
			return undefined
	}
}

function format(value: unknown): string {
	if (value === undefined || value === null) return ''
	if (typeof value === 'string') return quote(relativize(value))
	if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value)
	if (Array.isArray(value)) return quote(value.join(','))
	if (value instanceof Set) return quote([...value].join(','))
	return quote(JSON.stringify(value))
}

// defaults built from paths.ts are absolute and would otherwise bake the generating machine's cwd into a
// checked-in file
function relativize(value: string): string {
	if (!value.startsWith(Paths.PROJECT_ROOT + path.sep)) return value
	return './' + path.relative(Paths.PROJECT_ROOT, value).split(path.sep).join('/')
}

function quote(value: string): string {
	return /[\s#'"]/.test(value) ? JSON.stringify(value) : value
}

function section(title: string): string {
	return comment(` ${title} `.padStart(title.length + 6, '-').padEnd(COMMENT_WIDTH - 2, '-'))
}

function comment(line: string): string {
	return line ? `# ${line}` : '#'
}

function wrap(text: string): string[] {
	const lines: string[] = []
	let current = ''
	for (const word of text.split(' ')) {
		if (current && `${current} ${word}`.length > COMMENT_WIDTH) {
			lines.push(current)
			current = word
		} else {
			current = current ? `${current} ${word}` : word
		}
	}
	if (current) lines.push(current)
	return lines
}
