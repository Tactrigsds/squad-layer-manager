import { z } from 'zod'
import { withThrown } from './error'

export type LogMatcher<S extends EventSchema = EventSchema> = {
	regex: RegExp
	event: S
	onMatch: (args: RegExpMatchArray) => object | null
}

export function createLogMatcher<O extends EventSchema>(matcher: LogMatcher<O>) {
	return matcher
}

export function matchLog<LM extends LogMatcher>(line: string, matcher: LM) {
	const match = line.match(matcher.regex)
	if (!match) return [null, null] as const
	const [matchRes, err] = withThrown(() => matcher.onMatch(match))
	if (matchRes === null) return [null, null] as const
	if (err) {
		const error = new Error(`Failed to parse log line during onMatch for ${matcher.event.type}`, {
			cause: err ?? undefined,
		})
		;(error as any).logLine = line
		return [null, error] as const
	}
	const schemaRes = matcher.event.schema.safeParse(matchRes)
	if (!schemaRes.success) {
		const error = new Error(`Failed to validate parsed result for ${matcher.event.type}`, { cause: schemaRes.error })
		;(error as any).logLine = line
		return [null, error] as const
	}
	return [schemaRes.data as z.infer<LM['event']['schema']>, null] as const
}

export function eventDef<T extends string, P extends { [key: string]: z.ZodTypeAny }>(type: T, props: P) {
	return { schema: z.object(props).transform((data) => ({ type, ...data })), type }
}

export type EventSchema = ReturnType<typeof eventDef>
