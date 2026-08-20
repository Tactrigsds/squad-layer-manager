import { z } from 'zod'

// Mirrors sandbox.models.ts: schemas and metas only, so this stays importable from the client.
// The executor (setup and stages) is src/systems/tutorials.server.ts.

// How the filters a run creates for itself present. Here rather than with the rows in tutorials.server because
// the tour's copy shows the same emoji the indicator does, and the two drifting would make the card wrong.
export const TUTORIAL_FILTERS = {
	pool: { name: 'Tutorial Pool', emoji: '✅', invertedEmoji: '⛔' },
	large: { name: 'Large Layers', emoji: '🗺️' },
} as const

export const ScenarioIdSchema = z.enum(['layer-queue'])
export type ScenarioId = z.infer<typeof ScenarioIdSchema>

// the wire carries stage ids as strings; the scenario validates them on arrival, as sandbox
// verbs validate their args (parseVerbArgs)
export const StageIdSchema = z.string().min(1).max(64)

export const ScenarioMetaSchema = z.object({
	id: ScenarioIdSchema,
	// an honest estimate for the index page. Copy lives in tutorials.messages.ts, keyed by id
	minutes: z.int().min(1),
})
export type ScenarioMeta = z.infer<typeof ScenarioMetaSchema>

export const RunStateSchema = z.discriminatedUnion('code', [
	z.object({ code: z.literal('none') }),
	z.object({ code: z.literal('starting'), scenarioId: ScenarioIdSchema }),
	z.object({ code: z.literal('active'), scenarioId: ScenarioIdSchema, serverId: z.string() }),
])
export type RunState = z.infer<typeof RunStateSchema>

// what a stage answers. err:not-ready means the user has not done their part yet: an ordinary
// answer the card renders as guidance, against err:stage-failed which is a real fault.
export type StageResult = { code: 'ok' } | { code: 'err:not-ready'; msg: string }
