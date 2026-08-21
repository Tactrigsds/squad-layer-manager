import { type MessageFormatElement, parse, TYPE } from '@formatjs/icu-messageformat-parser'

import type * as ICU from '@/messages/icu'

// Resolves an ICU pattern to the form the runtime walks (@/messages/icu). Build-time only: this is the sole reason
// the app depends on an ICU parser at all, and it is a devDependency because of it.
//
// Value formatting is deliberately not supported. `{n, number}` and friends would drag skeleton parsing and its
// format tables into the runtime, and the app already formats values at the call site and interpolates the result
// (see @/messages/format). Patterns using them are rejected so the omission is a build error rather than a blank
// space in a sentence.

export class UnsupportedPatternError extends Error {
	constructor(readonly kind: string) {
		super(`{${kind}} formatting is not supported; format the value at the call site and interpolate the result`)
	}
}

function branches(options: Record<string, { value: MessageFormatElement[] }>): ICU.Branches {
	const out: Record<string, ICU.Message> = {}
	for (const [key, branch] of Object.entries(options)) out[key] = nodes(branch.value)
	return out
}

function nodes(elements: MessageFormatElement[]): ICU.Message {
	const out: ICU.Node[] = []
	for (const el of elements) {
		switch (el.type) {
			case TYPE.literal: {
				// merged here so the runtime never has to: the parser splits on every quoted section
				const last = out[out.length - 1]
				if (typeof last === 'string') out[out.length - 1] = last + el.value
				else out.push(el.value)
				break
			}
			case TYPE.pound:
				out.push(0)
				break
			case TYPE.argument:
				out.push([el.value])
				break
			case TYPE.tag:
				out.push([el.value, 'tag', nodes(el.children)])
				break
			case TYPE.select:
				out.push([el.value, 'select', branches(el.options)])
				break
			case TYPE.plural:
				out.push([el.value, el.pluralType === 'ordinal' ? 'selectordinal' : 'plural', branches(el.options), el.offset || 0])
				break
			case TYPE.number:
				throw new UnsupportedPatternError('number')
			case TYPE.date:
				throw new UnsupportedPatternError('date')
			case TYPE.time:
				throw new UnsupportedPatternError('time')
		}
	}
	return out
}

// A message with no arguments compiles to its own text, which is what makes most of a catalogue plain strings.
export function compile(pattern: string): ICU.Entry {
	const compiled = nodes(parse(pattern))
	if (compiled.length === 0) return ''
	if (compiled.length === 1 && typeof compiled[0] === 'string') return compiled[0]
	return compiled
}
