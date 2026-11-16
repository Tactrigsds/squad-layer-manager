// Turns what the YAML parser and a zod schema report into problems at the span of the text they are about. Imported
// only by lazily loaded editors, since it pulls in the whole `yaml` package.
import { assertNever } from '@/lib/type-guards'
import * as Yaml from '@/lib/yaml'
import type { z } from '@/lib/zod'
import * as UI_Msgs from '@/messages/ui.messages'
import * as EP from '@/models/editor-problems.models'
import { tr } from '@/systems/messages.client'

// a parse that failed in Yaml.parseValue or Yaml.parseWithComments
export function yamlErrorProblem(text: string, err: unknown): EP.Problem {
	if (err instanceof Yaml.YAMLError) return EP.at(text, err.pos[0], err.pos[1], err.message)
	return EP.at(text, 0, 0, err instanceof Error ? err.message : String(err))
}

export function schemaProblems(text: string, issues: readonly z.core.$ZodIssue[]): EP.Problem[] {
	const doc = Yaml.parseDocument(text, { prettyErrors: false })
	return issues.flatMap((issue) => issueProblems(text, doc, issue)).sort(EP.byPosition)
}

function issueProblems(text: string, doc: Yaml.Document, issue: z.core.$ZodIssue): EP.Problem[] {
	const problemAt = (span: { from: number; to: number }, message: string) => EP.at(text, span.from, span.to, message)
	switch (issue.code) {
		case 'unrecognized_keys':
			return issue.keys.map((key) =>
				problemAt(Yaml.locate(doc, [...issue.path, key], { key: true }), tr.text(UI_Msgs.issueUnknownField(key))),
			)
		case 'invalid_union': {
			if (!issue.discriminator) return [problemAt(Yaml.locate(doc, issue.path), tr.text(UI_Msgs.issueNoMatchingForm()))]
			const field = issue.discriminator
			// zod ends the path at the discriminator when the object has one, and at the object when it has none
			const path = issue.path.at(-1) === field ? issue.path : [...issue.path, field]
			const span = Yaml.locate(doc, path)
			if (!span.found) return [problemAt(span, tr.text(UI_Msgs.issueMissingField(field)))]
			const options = 'options' in issue ? issue.options : undefined
			const message = options?.length
				? tr.text(UI_Msgs.issueUnknownOption(field, listValues(options)))
				: tr.text(UI_Msgs.issueNoMatchingForm())
			return [problemAt(span, message)]
		}
		case 'invalid_type': {
			const span = Yaml.locate(doc, issue.path)
			const last = issue.path.at(-1)
			// zod leaves the input out of an issue, so a field the text never wrote shows up as one that cannot be located
			if (!span.found && typeof last === 'string') return [problemAt(span, tr.text(UI_Msgs.issueMissingField(last)))]
			return [problemAt(span, tr.text(UI_Msgs.issueExpectedType(issue.expected)))]
		}
		case 'invalid_value':
			return [problemAt(Yaml.locate(doc, issue.path), tr.text(UI_Msgs.issueExpectedOneOf(listValues(issue.values))))]
		case 'too_small':
		case 'too_big':
			return [problemAt(Yaml.locate(doc, issue.path), sizeMessage(issue) ?? issue.message)]
		case 'invalid_format':
		case 'not_multiple_of':
		case 'invalid_key':
		case 'invalid_element':
		case 'custom':
			return [problemAt(Yaml.locate(doc, issue.path), issue.message)]
		default:
			return assertNever(issue)
	}
}

export function problemAtPath(text: string, path: readonly PropertyKey[], message: string): EP.Problem {
	const span = Yaml.locate(Yaml.parseDocument(text, { prettyErrors: false }), path)
	return EP.at(text, span.from, span.to, message)
}

function sizeMessage(issue: z.core.$ZodIssueTooSmall | z.core.$ZodIssueTooBig): string | null {
	if (issue.exact) return null
	const small = issue.code === 'too_small'
	const bound = Number(small ? issue.minimum : issue.maximum)
	// an exclusive bound on a count is the inclusive one next to it
	const limit = issue.inclusive === false ? bound + (small ? 1 : -1) : bound
	switch (issue.origin) {
		case 'string':
			return tr.text(small ? UI_Msgs.issueMinLength(limit) : UI_Msgs.issueMaxLength(limit))
		case 'array':
		case 'set':
			return tr.text(small ? UI_Msgs.issueMinItems(limit) : UI_Msgs.issueMaxItems(limit))
		case 'number':
		case 'int':
			if (issue.inclusive === false) return tr.text(small ? UI_Msgs.issueAbove(bound) : UI_Msgs.issueBelow(bound))
			return tr.text(small ? UI_Msgs.issueAtLeast(bound) : UI_Msgs.issueAtMost(bound))
		default:
			return null
	}
}

function listValues(values: readonly unknown[]) {
	return values.map((value) => JSON.stringify(value)).join(', ')
}
