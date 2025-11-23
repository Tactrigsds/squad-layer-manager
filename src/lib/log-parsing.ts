import type { z } from 'zod'
import { withThrown } from './error'

export type LogMatcher<O extends object = object> = {
	regex: RegExp
	schema: z.ZodType<O>
	onMatch: (args: RegExpMatchArray) => O
}

export function createLogMatcher<O extends object>(matcher: LogMatcher<O>) {
	return matcher
}

export function matchLog<LM extends LogMatcher>(log: string, matcher: LM) {
	const match = log.match(matcher.regex)
	if (!match) return [null, null] as const
	const [matchRes, err] = withThrown(() => matcher.onMatch(match))
	if (err) return [null, err] as const
	const schemaRes = matcher.schema.safeParse(matchRes)
	if (!schemaRes.success) return [null, schemaRes.error] as const
	return [schemaRes.data as z.infer<LM['schema']>, null]
}
