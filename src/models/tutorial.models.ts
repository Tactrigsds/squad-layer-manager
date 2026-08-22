import { z } from 'zod'

// Mirrors sandbox.models.ts: schemas and metas only, so this stays importable from the client.
// The executor (setup and stages) is src/systems/tutorials.server.ts.

// How the filters a run creates for itself present. Here rather than with the rows in tutorials.server because
// the tour's copy shows the same emoji the indicator does, and the two drifting would make the card wrong.
export const TUTORIAL_FILTERS = {
	pool: { name: 'Tutorial Pool', emoji: '✅', invertedEmoji: '⛔' },
	large: { name: 'Large Layers', emoji: '🗺️' },
} as const

// Global-handle ids (src/lib/use-state-with-global-handle.ts) for the component-local state a tour jump has to
// drive. Here so the owning components and the steps files share one vocabulary.
export const TOUR_HANDLES = {
	poolConfigTab: 'pool-config-tab',
	layerInfoTab: 'layer-info-tab',
	queueSaveWarnings: 'queue-save-warnings',
} as const

// The layer-queue scenario's canonical layers, shared by the server checkpoints and the client simulates so both
// halves reconstruct the same states. Every id must exist in the layer data that ships with the app. The picks are
// what the add walkthrough asks for: Chora is Medium (in pool, no Large indicator), Yehorivka is Large, and both
// carry CAF so the reader's additions repeat a faction within the pool's warn rule.
//
// The head is the layer the scores arc reads its examples off, so its matchup is load-bearing copy: ADF Combined
// Arms against AFU Light Infantry is slightly in ADF's favor and visibly asymmetric without leaving the pool,
// which is what those two cards say. It is on Harju, the map the emulator opens on, so the head still carries a
// repeat indicator for the step that points at one. Changing it means rechecking both.
export const LQ_TUTORIAL_LAYERS = {
	initial: ['HJ-AAS-V1:ADF-CA:AFU-LI', 'HJ-RAAS-V1:RGF-MZ:PLA-AA', 'NV-RAAS-V1:USA-CA:RGF-CA'],
	picks: { chora: 'CH-TC-V1:CAF-CA:MEI-CA', yehorivka: 'YH-TC-V1:CAF-CA:RGF-CA' },
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

// Where a user is in a tutorial. `stepId` is the step's own id rather than its index, because the step list is
// built per run from what the install supports. A step id that no longer exists resolves to nothing, and the
// reader starts over rather than landing somewhere arbitrary.
export const ProgressSchema = z.object({
	scenarioId: ScenarioIdSchema,
	stepId: z.string().nullable(),
	completed: z.boolean(),
})
export type Progress = z.infer<typeof ProgressSchema>

// A page that offers tutorials when it opens, and which ones. Adding a page is an entry here plus mounting the
// dialog on that route; the dialog itself is the same everywhere.
export const SurfaceIdSchema = z.enum(['server-dashboard'])
export type SurfaceId = z.infer<typeof SurfaceIdSchema>

export const RECOMMENDED_TUTORIALS: Record<SurfaceId, ScenarioId[]> = {
	'server-dashboard': ['layer-queue'],
}

// what a stage answers. err:not-ready means the user has not done their part yet: an ordinary
// answer the card renders as guidance, against err:stage-failed which is a real fault.
export type StageResult = { code: 'ok' } | { code: 'err:not-ready'; msg: string }
