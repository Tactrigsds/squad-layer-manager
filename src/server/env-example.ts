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
//
// A deployment's file is split in two: the credentials go to .env.secrets.example and everything else to
// .env.example (see docs/INSTALLING.md). A checkout keeps one file, since `pnpm server:dev` expects to find
// everything in .env.

export type Audience = 'deployment' | 'dev'

type Target = {
	audience: Audience
	// which half of the vars this file carries. A checkout's file takes both.
	contents: 'plain' | 'secrets' | 'all'
	path: string
	header: string[]
}

const COMMENT_WIDTH = 110

export const TARGETS: Target[] = [
	{
		audience: 'deployment',
		contents: 'plain',
		path: path.join(Paths.PROJECT_ROOT, '.env.example'),
		header: [
			'The environment SLM runs on, minus the credentials, which go in .env.secrets (see .env.secrets.example).',
			'',
			'Fill in the vars left uncommented. Commented-out vars are optional and show their default.',
		],
	},
	{
		audience: 'deployment',
		contents: 'secrets',
		path: path.join(Paths.PROJECT_ROOT, '.env.secrets.example'),
		header: [
			'Every credential SLM reads. It is mounted into the container as a file rather than passed as environment',
			'variables. To point SECRETS_FILE at a docker secret instead, see',
			`${Env.DOCS}/docs/INSTALLING.md`,
			'',
			'Treat it as a private key: keep it out of any backup you would not put a password in.',
		],
	},
	{
		audience: 'dev',
		contents: 'all',
		path: path.join(Paths.PROJECT_ROOT, '.env.example.dev'),
		// nothing: CONTRIBUTING.md is where a checkout is told what to do with this file
		header: [],
	},
]

export function build(target: Target): string {
	const lines: string[] = target.header.map(comment)
	for (const [groupName, group] of Object.entries(Env.groups)) {
		const rendered = Object.entries(group as Record<string, z.ZodType>)
			.filter(([, schema]) => target.contents === 'all' || Env.isSecret(schema) === (target.contents === 'secrets'))
			.map(([name, schema]) => renderVar(name, schema, target.audience))
			.filter(v => v !== undefined)
		if (rendered.length === 0) continue

		const meta = Env.groupMeta[groupName as keyof typeof Env.groups]
		if (lines.length > 0) lines.push('')
		lines.push(section(meta.title))
		// the dev file carries nothing but the vars and a line each on what they are: a checkout has env.ts
		if (meta.description && target.audience === 'deployment') lines.push(...wrap(meta.description).map(comment), '')
		lines.push(rendered.join('\n\n'))
	}
	return lines.join('\n') + '\n'
}

// returns the files whose contents changed, so the caller can say which. Nothing in the app reads these back,
// so an example that fails to write is never worth interrupting a boot for.
export function write(): { changed: string[] } {
	const changed: string[] = []
	for (const target of TARGETS) {
		const filePath = target.path
		const content = build(target)
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
