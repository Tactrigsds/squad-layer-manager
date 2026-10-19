import { z } from '@/lib/zod'
import * as LDC from '@/models/layer-data-cache.models'
import * as L from '@/models/layer.models'

// Mirrors sandbox.models.ts: schemas and metas only, so this stays importable from the client.
// The executor (setup and stages) is src/systems/tutorials.server.ts.

// How the filters a run creates for itself present. Here rather than with the rows in tutorials.server because
// the tour's copy shows the same emoji the indicator does, and the two drifting would make the card wrong.
export const TUTORIAL_FILTERS = {
	pool: { name: 'Tutorial Pool', emoji: '✅', invertedEmoji: '⛔' },
	large: { name: 'Large Layers', emoji: '🗺️' },
} as const

// Global-handle ids (useState_withGlobalHandle in src/systems/tutorials.client.ts) for the component-local state a tour jump has to
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
const LQ_TUTORIAL_LAYER_TEXT = {
	initial: [
		'Harju_AAS_v1:ADF+CombinedArms:AFU+LightInfantry',
		'Harju_RAAS_v1:RGF+Mechanized:PLA+AirAssault',
		'Narva_RAAS_v1:USA+CombinedArms:RGF+CombinedArms',
	],
	picks: { chora: 'Chora_TC_v1:CAF+CombinedArms:MEI+CombinedArms', yehorivka: 'Yehorivka_TC_v1:CAF+CombinedArms:RGF+CombinedArms' },
} as const

// the layer queue scenario's layers as ids, which only exist once layer data has loaded
export function lqTutorialLayers(components = L.StaticLayerComponents) {
	return lqTutorialLayersOf(components)
}
const lqTutorialLayersOf = LDC.derived((components) => {
	const id = (text: string) => L.fromLayerText(text, components)!
	return {
		initial: LQ_TUTORIAL_LAYER_TEXT.initial.map(id),
		picks: { chora: id(LQ_TUTORIAL_LAYER_TEXT.picks.chora), yehorivka: id(LQ_TUTORIAL_LAYER_TEXT.picks.yehorivka) },
	}
})

// The player management scenario's roster, shared by the server setup and the client steps so both halves name the
// same people. Eight a side, so a lone /switch queues rather than firing on the spot. Each player's team is the raw
// slot of the opening match, and `squad` is the squad they join; the first player listed for a squad leads it.
// `groups` are admin-list groups from the emulated server's seeded list (SB.SEEDED_ADMIN_GROUPS), which is what a
// fresh install's own grouping reads.
export type PMRosterPlayer = { name: string; team: 1 | 2; squad: string | null; groups: string[] }

export const PM_TUTORIAL_ROSTER: PMRosterPlayer[] = [
	{ name: 'Kestrel', team: 1, squad: 'ALPHA', groups: ['Admin', 'Regular'] },
	{ name: 'Marlow', team: 1, squad: 'ALPHA', groups: ['Regular'] },
	{ name: 'Brightwater', team: 1, squad: 'ALPHA', groups: [] },
	{ name: 'Okafor', team: 1, squad: 'ALPHA', groups: ['SquadLeader'] },
	{ name: 'Lindqvist', team: 1, squad: 'ARMOR', groups: ['ArmorPlayer'] },
	{ name: 'Tanaka', team: 1, squad: 'ARMOR', groups: ['ArmorPlayer', 'Regular'] },
	{ name: 'Ruiz', team: 1, squad: null, groups: ['Watchlist'] },
	{ name: 'Novak', team: 1, squad: null, groups: [] },
	{ name: 'Hollis', team: 2, squad: 'BRAVO', groups: ['SquadLeader'] },
	{ name: 'Petrov', team: 2, squad: 'BRAVO', groups: ['Regular'] },
	{ name: 'Adeyemi', team: 2, squad: 'BRAVO', groups: [] },
	{ name: 'Castellan', team: 2, squad: 'BRAVO', groups: ['Watchlist'] },
	{ name: 'Weiss', team: 2, squad: 'LOGI', groups: ['Admin'] },
	{ name: 'Moreau', team: 2, squad: 'LOGI', groups: ['Regular'] },
	{ name: 'Sato', team: 2, squad: null, groups: [] },
	{ name: 'Quill', team: 2, squad: null, groups: ['ArmorPlayer'] },
]

// The players the tour asks the reader to act on, one per action so no step's target has been kicked, timed out or
// moved by an earlier one.
export const PM_TUTORIAL_TARGETS = {
	details: 'Marlow',
	kick: 'Novak',
	timeout: 'Ruiz',
	swapNow: 'Sato',
	swapNext: 'Tanaka',
	switchRequest: 'Brightwater',
	squadWarn: 'BRAVO',
} as const

export const ScenarioIdSchema = z.enum(['layer-queue', 'player-management'])
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

// A tutorial's chapters, in order, and the ids of the steps each one holds. The steps files build the step list and a
// run checks it against this outline, which is what lets the index page place a saved step in its chapter without
// loading a steps file. A step that only some installs get is listed all the same. Names are copy, in
// tutorials.messages.ts, keyed by chapter id. A chapter's first step must be one every install gets, because starting
// from a chapter resumes at it.
export type Chapter = { id: string; steps: readonly string[] }

export const CHAPTERS = {
	'layer-queue': [
		{ id: 'getting-started', steps: ['welcome', 'sandbox', 'match-history'] },
		{
			id: 'reading-the-queue',
			steps: ['queue-panel', 'queue-items', 'next-badge', 'layer-anatomy', 'team-normalize', 'filter-indicators', 'repeat-indicators'],
		},
		{
			id: 'layer-details',
			steps: [
				'open-layer-details',
				'layer-details',
				'open-layer-scores',
				'layer-scores',
				'balance-score',
				'asymmetry-score',
				'category-scores',
				'layer-scores-nonstandard',
				'close-layer-details',
			],
		},
		{
			id: 'finding-layers',
			steps: [
				'layer-context-menu',
				'start-editing',
				'queue-editors',
				'add-layers-button',
				'add-dialog-tour',
				'layer-filter-menu',
				'results-table',
				'results-pagination',
				'results-sorting',
				'results-randomization',
				'applied-filters',
			],
		},
		{
			id: 'choosing-layers',
			steps: [
				'results-repeats',
				'hide-repeats',
				'click-to-select',
				'results-context-menu',
				'add-another',
				'see-selection',
				'add-submit',
			],
		},
		{
			id: 'editing-items',
			steps: [
				'added-highlight',
				'layer-attribution',
				'reorder',
				'remove-layer',
				'swap-teams',
				'edit-layer',
				'edit-layer-dialog',
				'item-menu',
				'replay-layer',
				'add-tag',
				'add-note',
			],
		},
		{
			id: 'saving',
			steps: ['save', 'warnings-on-save', 'force-save-editing', 'collaborative-editing', 'force-save-edit', 'force-save'],
		},
		{
			id: 'generation-and-pool',
			steps: [
				'autogen-intro',
				'autogen-editing',
				'autogen-try',
				'autogen-item',
				'open-pool-settings',
				'pool-settings',
				'pool-filter',
				'indicate-matches',
				'default-select',
			],
		},
		{ id: 'repeat-rules', steps: ['view-repeat-rules', 'repeat-rules', 'repeat-rule', 'target-values', 'rule-options'] },
		{ id: 'next-layer-settings', steps: ['view-next-layer', 'override-admin-set-next-layer', 'warn-on-next-layer-change'] },
	],
	'player-management': [
		{
			id: 'server-activity',
			steps: ['welcome', 'activity-panel', 'activity-filter', 'activity-select', 'activity-copy', 'activity-warn'],
		},
		{
			id: 'match-history',
			steps: ['mh-overview', 'mh-time', 'mh-outcome', 'mh-kd', 'mh-set-by', 'mh-open', 'mh-viewing', 'mh-arrows', 'mh-live', 'mh-days'],
		},
		{ id: 'teams-panel', steps: ['find-teams', 'teams-header', 'groupings-column', 'grouping-modes'] },
		{
			id: 'teams-breakdown',
			steps: ['breakdown', 'breakdown-hover', 'breakdown-filter', 'breakdown-select', 'breakdown-unmatched', 'breakdown-history'],
		},
		{
			id: 'finding-players',
			steps: [
				'column-filter',
				'remove-filter',
				'search',
				'squad-sorting',
				'show-spoilers',
				'score-sorting',
				'selecting',
				'warn-selected',
				'reset-panel',
			],
		},
		{
			id: 'player-details',
			steps: [
				'open-player-details',
				'player-details',
				'player-details-ids',
				'player-details-tags',
				'player-details-activity',
				'warn-box',
				'warn-options',
				'warn-presets',
				'warn-ingame',
				'warn-squad',
			],
		},
		{
			id: 'kicks-and-timeouts',
			steps: ['actions-menu', 'kick', 'kick-ingame', 'timeout', 'timeouts-open', 'timeouts-list', 'timeouts-ingame'],
		},
		{
			id: 'team-swaps',
			steps: [
				'swap-now',
				'swap-now-ingame',
				'swap-next',
				'swaps-panel',
				'swaps-add-more',
				'swaps-remove',
				'swaps-save',
				'swaps-execute',
				'teamswaps-ingame',
			],
		},
		{
			id: 'switch-requests',
			steps: ['other-actions', 'switch-request', 'switch-open', 'switch-window', 'switch-now', 'switch-ingame', 'finish'],
		},
	],
} as const satisfies Record<ScenarioId, readonly Chapter[]>

export type ChapterId<S extends ScenarioId> = (typeof CHAPTERS)[S][number]['id']

// the index into CHAPTERS[scenarioId] of the chapter holding stepId, or -1 for a step id the outline does not know
export function chapterIndexOf(scenarioId: ScenarioId, stepId: string): number {
	return (CHAPTERS[scenarioId] as readonly Chapter[]).findIndex((chapter) => chapter.steps.includes(stepId))
}

// A page that offers tutorials when it opens, and which ones. Adding a page is an entry here plus mounting the
// dialog on that route; the dialog itself is the same everywhere.
export const SurfaceIdSchema = z.enum(['server-dashboard'])
export type SurfaceId = z.infer<typeof SurfaceIdSchema>

export const RECOMMENDED_TUTORIALS: Record<SurfaceId, ScenarioId[]> = {
	'server-dashboard': ['layer-queue', 'player-management'],
}

// what a stage answers. err:not-ready means the user has not done their part yet: an ordinary
// answer the card renders as guidance, against err:stage-failed which is a real fault.
export type StageResult = { code: 'ok' } | { code: 'err:not-ready'; msg: string }

// the newest op id on each synced stream a stage can write, per stream; undefined for a stream with no ops yet
export type StageSyncTokens = { presence?: string; queue?: string; teamswaps?: string }
