import { createIntl } from '@formatjs/intl'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import { describe, expect, test } from 'vitest'

import * as ICU from '@/messages/icu'
import { compile, UnsupportedPatternError } from '@/scripts/compile-messages'

// Every message, rendered by the walker and by formatjs, has to come out the same. This is the only thing that
// makes replacing the engine under 1,700 patterns safe, and it lives for exactly as long as both engines do.
//
// The catalogue is the corpus that matters, but it only covers what the app happens to write today: no message
// uses a plural offset or a selectordinal. PATTERNS covers the rest of what the walker claims to support.
//
// Locales are chosen for what distinguishes a wrong answer: pl has four plural categories and a non-breaking-space
// group separator, ar has all six, ar-EG renders Arabic-Indic digits.

const LOCALES = ['en', 'pl', 'ar', 'ar-EG']

const PATTERNS = [
	'{n, plural, offset:1 one {you and one other} other {you and # others}}',
	'{n, plural, offset:2 =0 {nobody} one {# person} other {# people}}',
	'{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}} place',
	'{n, plural, =0 {none} =1 {just one} one {# thing} other {# things}}',
	'a <b>nested <i>tags</i> here</b> z',
	'<b>{n, plural, one {# a} other {# b}}</b>',
	'{n, plural, one {<b>#</b> thing} other {<b>#</b> things}}',
	'{outer, select, a {<b>{inner}</b>} other {{inner}}}',
	'{a, select, x {X} other {O}}{b, select, y {Y} other {P}}',
	"it''s {n, plural, one {# item} other {# items}}",
	"quoted '{braces}' stay literal",
	'{n, plural, other {#}}',
]

const source: Record<string, string> = JSON.parse(fs.readFileSync('src/messages/locales/en.json', 'utf8'))
const compiled: Record<string, ICU.Entry> = JSON.parse(fs.readFileSync('src/messages/locales/en.compiled.json', 'utf8'))

// The values a pattern needs, read off its compiled form. Each argument gets every value that reaches a different
// branch, so a round of renders covers every branch of every message.
type Arg = { options: unknown[] }

// grouped and multi-digit numbers, which is what tells a locale-formatted `#` from a stringified one
const PLURAL_NUMBERS = [0, 1, 2, 3, 5, 11, 21, 100, 1000, 1234567]

function collect(message: ICU.Message, args: Map<string, Arg>) {
	for (const node of message) {
		if (typeof node === 'string' || node === 0) continue
		const [name] = node
		if (node.length === 1) {
			args.set(name, { options: ['x'] })
			continue
		}
		if (node[1] === 'tag') {
			args.set(name, { options: [(chunks: unknown[]) => `<${name}>${chunks.join('')}</${name}>`] })
			collect(node[2], args)
			continue
		}
		if (node[1] === 'select') {
			// an unlisted key too, so `other` is reached even when every listed branch is exercised
			args.set(name, { options: [...Object.keys(node[2]), 'not-a-branch'] })
			for (const branch of Object.values(node[2])) collect(branch, args)
			continue
		}
		const exact = Object.keys(node[2])
			.filter((k) => k.startsWith('='))
			.map((k) => Number(k.slice(1)))
		args.set(name, { options: [...new Set([...exact, ...PLURAL_NUMBERS])] })
		for (const branch of Object.values(node[2])) collect(branch, args)
	}
}

function valueSets(entry: ICU.Entry) {
	if (typeof entry === 'string') return [{}]
	const args = new Map<string, Arg>()
	collect(entry, args)
	const rounds = Math.max(1, ...[...args.values()].map((a) => a.options.length))
	return Array.from({ length: rounds }, (_, round) => {
		const values: Record<string, unknown> = {}
		for (const [name, arg] of args) values[name] = arg.options[round % arg.options.length]
		return values
	})
}

function attempt(render: () => unknown) {
	try {
		const parts = render()
		return Array.isArray(parts) ? parts.join('') : String(parts)
	} catch {
		return '<error>'
	}
}

function differential(locale: string, catalogue: Record<string, string>, entryOf: (key: string, pattern: string) => ICU.Entry) {
	// swallowed, as @/messages/i18n swallows it: a pattern ICU rejects reaches the reader verbatim, and two of the
	// app's messages are prose containing braces that rely on exactly that
	const intl = createIntl({ locale, defaultLocale: locale, messages: catalogue, onError: () => {} })
	const mismatches: string[] = []
	let renders = 0
	for (const [key, pattern] of Object.entries(catalogue)) {
		const entry = entryOf(key, pattern)
		for (const values of valueSets(entry)) {
			renders++
			const theirs = attempt(() => intl.formatMessage({ id: key }, values as Record<string, string>))
			const ours = attempt(() => ICU.evaluate(entry, values, locale))
			if (theirs !== ours) {
				mismatches.push(`${JSON.stringify(key)}\n  values:   ${JSON.stringify(values)}\n  formatjs: ${theirs}\n  walker:   ${ours}`)
			}
		}
	}
	return { renders, report: mismatches.slice(0, 10).join('\n\n') }
}

describe.each(LOCALES)('%s', (locale) => {
	test('renders the catalogue the same as formatjs', () => {
		const { renders, report } = differential(locale, source, (key, pattern) => compiled[key] ?? pattern)
		expect(report).toBe('')
		expect(renders).toBeGreaterThan(Object.keys(source).length)
	})

	test('renders offsets, ordinals and nested tags the same as formatjs', () => {
		const catalogue = Object.fromEntries(PATTERNS.map((p) => [p, p]))
		const { renders, report } = differential(locale, catalogue, (_, pattern) => compile(pattern))
		expect(report).toBe('')
		expect(renders).toBeGreaterThan(PATTERNS.length * 5)
	})
})

// The compiled catalogue is what the runtime reads, so a stale one silently renders yesterday's copy. Run here
// rather than left to whoever remembers `pnpm i18n:lint`, because the pre-push hook runs the unit suite.
test('the catalogues on disk match the messages in src', () => {
	expect(() => execFileSync('pnpm', ['-s', 'i18n:lint'], { encoding: 'utf8', stdio: 'pipe' })).not.toThrow()
})

test('value formatting is rejected at build time rather than dropped at runtime', () => {
	for (const pattern of ['{n, number}', '{n, number, percent}', '{d, date, short}', '{t, time, medium}']) {
		expect(() => compile(pattern)).toThrow(UnsupportedPatternError)
	}
})

// A message rendered without its values has to fail rather than come out with a hole in it, so that the caller can
// fall back to the source. Asserted here rather than against formatjs, which reports the same case through a
// callback and then returns the pattern verbatim.
test('a missing value or tag renderer is refused', () => {
	const cases: [string, ICU.Values][] = [
		['{n} left', {}],
		['{n, plural, one {# thing} other {# things}}', {}],
		['{choice, select, a {A} other {O}}', {}],
		['press <b>{key}</b>', { key: 'x' }],
		['press <b>{key}</b>', { b: (c: unknown[]) => c.join('') }],
	]
	for (const [pattern, values] of cases) {
		expect(() => ICU.evaluate(compile(pattern), values, 'en')).toThrow(ICU.MissingValueError)
	}
	expect(ICU.evaluate(compile('press <b>{key}</b>'), { key: 'x', b: (c: unknown[]) => `[${c.join('')}]` }, 'en').join('')).toBe(
		'press [x]',
	)
})
