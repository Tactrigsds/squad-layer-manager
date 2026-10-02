import { withThrown } from './error'
import { z } from './zod.ts'

export type LogMatcher<S extends EventSchema = EventSchema> = {
	regex: RegExp
	event: S
	onMatch: (args: RegExpMatchArray) => object | null
}

export function createLogMatcher<O extends EventSchema>(matcher: LogMatcher<O>) {
	return matcher
}

export function matchLog<LM extends LogMatcher>(line: string, matchers: readonly LM[]) {
	for (const matcher of matchers) {
		const match = line.match(matcher.regex)
		if (!match) continue
		const [matchRes, err] = withThrown(() => matcher.onMatch(match))
		if (err) {
			const error = new Error(`Failed to parse log line during onMatch for ${matcher.event.type}`, {
				cause: err ?? undefined,
			})
			;(error as any).logLine = line
			return [null, error] as const
		}
		if (matchRes === null) continue
		const schemaRes = matcher.event.schema.safeParse(matchRes)
		if (!schemaRes.success) {
			const error = new Error(`Failed to validate parsed result for ${matcher.event.type}`, { cause: schemaRes.error })
			;(error as any).logLine = line
			return [null, error] as const
		}
		return [schemaRes.data as z.infer<LM['event']['schema']>, null] as const
	}

	return [null, null] as const
}

// The `[time][chain]` prefix every Unreal log entry starts with, as matcher regexes spell it. The category that
// follows it (`LogSquad`, `LogNet`, ...) is a literal in the regex, so a line of another category cannot match.
const ENTRY_PREFIX_SRC = String.raw`^\[([0-9.:-]+)]\[([ 0-9]*)]`
const ENTRY_CATEGORY = /^\[[0-9.:-]+]\[[ 0-9]*]([A-Za-z]+):/

export type MatcherIndex<LM extends LogMatcher> = {
	byCategory: Map<string, LM[]>
	// matchers whose regex names no category, run on every entry
	uncategorized: LM[]
}

// Each category's list keeps the original order, with the uncategorized matchers in their original places, so
// matchLogIndexed returns exactly what matchLog over the full list would.
export function indexByCategory<LM extends LogMatcher>(matchers: readonly LM[]): MatcherIndex<LM> {
	const categoryOf = (matcher: LM) => {
		const src = matcher.regex.source
		if (!src.startsWith(ENTRY_PREFIX_SRC)) return null
		return /^([A-Za-z]+):/.exec(src.slice(ENTRY_PREFIX_SRC.length))?.[1] ?? null
	}
	const categories = new Set<string>()
	for (const matcher of matchers) {
		const category = categoryOf(matcher)
		if (category) categories.add(category)
	}
	const byCategory = new Map<string, LM[]>()
	for (const category of categories) {
		byCategory.set(
			category,
			matchers.filter((m) => {
				const c = categoryOf(m)
				return c === null || c === category
			}),
		)
	}
	return { byCategory, uncategorized: matchers.filter((m) => categoryOf(m) === null) }
}

export function matchLogIndexed<LM extends LogMatcher>(line: string, index: MatcherIndex<LM>) {
	const category = ENTRY_CATEGORY.exec(line)?.[1]
	return matchLog(line, (category && index.byCategory.get(category)) || index.uncategorized)
}

export function eventDef<T extends string, P extends { [key: string]: z.ZodType }>(type: T, props: P) {
	return { schema: z.object(props).transform((data) => ({ type, ...data })), type }
}

export type EventSchema = ReturnType<typeof eventDef>
