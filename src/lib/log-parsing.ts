import { z } from 'zod'
import { withThrown } from './error'

export type LogMatcher<S extends z.ZodTypeAny = z.ZodTypeAny> = {
	regex: RegExp
	schema: S
	onMatch: (args: RegExpMatchArray) => any
}

export function createLogMatcher<O extends z.ZodTypeAny>(matcher: LogMatcher<O>) {
	return matcher
}

export function matchLog<LM extends LogMatcher>(line: string, matcher: LM) {
	const match = line.match(matcher.regex)
	if (!match) return [null, null] as const
	const [matchRes, err] = withThrown(() => matcher.onMatch(match))
	if (err) return [null, err] as const
	const schemaRes = matcher.schema.safeParse(matchRes)
	if (!schemaRes.success) return [null, schemaRes.error] as const
	return [schemaRes.data as z.infer<LM['schema']>, null]
}

export function eventSchema<T extends string, P extends { [key: string]: z.ZodTypeAny }>(type: T, props: P) {
	return z.object(props).transform((data) => ({ type, ...data }))
}
