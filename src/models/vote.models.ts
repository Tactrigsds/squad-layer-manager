import type { MutexInterface } from 'async-mutex'

import * as CD from '@/lib/ctx-def'
import * as Obj from '@/lib/object-utils'
import type * as Rx from '@/lib/rxjs'
import type { DistributiveOmit, Parts } from '@/lib/types'
import { z } from '@/lib/zod'
import * as ZodUtils from '@/lib/zod-utils'
import * as CS from '@/models/context-shared.models'
import * as DH from '@/models/display-helpers.models'
import * as L from '@/models/layer.models'
import * as SM from '@/models/squad.models'
import * as USR from '@/models/users.models'

import type * as LC from './layer-columns.models'
import * as LL from './layer-list.models'

export const DEFAULT_NUM_CHOICES = 3
export const VOTER_TYPE = z.enum(['public', 'internal'])
export type VoterType = z.infer<typeof VOTER_TYPE>

// a plugin starting a vote on its own initiative
export const PluginInitiatorSchema = z.object({ pluginId: z.string() })
export type PluginInitiator = z.infer<typeof PluginInitiatorSchema>
export type VoteInitiator = USR.GuiOrChatUserId | PluginInitiator

export function isPluginInitiator(initiator: VoteInitiator | 'autostart'): initiator is PluginInitiator {
	return typeof initiator === 'object' && 'pluginId' in initiator
}

// a broadcast lists every choice, and Squad cuts off a long one
export const MAX_CHOICE_TEXT_LENGTH = 48

// What players see for one choice in place of its layer's name. Keyed by layer rather than by queue item, because a
// vote's choices are configured before they become items (the Generate Vote dialog), and a choice whose layer is
// swapped for another should not keep a text written for the old one.
export const ChoiceTextSchema = z.object({
	layerId: z.lazy(() => L.LayerIdSchema),
	text: z.string().trim().min(1).max(MAX_CHOICE_TEXT_LENGTH),
})
export type ChoiceText = z.infer<typeof ChoiceTextSchema>

export const AdvancedVoteConfigSchema = z.object({
	duration: z.number().positive().optional(),
	displayProps: z.lazy(() => z.array(DH.LAYER_DISPLAY_PROP).optional()),
	choiceTexts: z.array(ChoiceTextSchema).optional(),
})

export type AdvancedVoteConfig = z.infer<typeof AdvancedVoteConfigSchema>

export type VoteChoice = { id: string; label: string }

export function choiceText(config: Partial<AdvancedVoteConfig> | undefined, layerId: L.LayerId): string | undefined {
	return config?.choiceTexts?.find((c) => L.layersEqual(c.layerId, layerId))?.text
}

// what players see for a choice: its text when it has one, and otherwise its layer as the display props describe it
export function choiceLabel(
	layerId: L.LayerId,
	config: Partial<AdvancedVoteConfig> | undefined,
	defaultDisplayProps: DH.LayerDisplayProp[],
): string {
	return choiceText(config, layerId) ?? DH.toShortLayerNameFromId(layerId, undefined, config?.displayProps ?? defaultDisplayProps)
}

// a vote item's choices as players see them, in `choiceIds` order when given
export function voteItemChoices(
	item: LL.VoteItem,
	defaultDisplayProps: DH.LayerDisplayProp[],
	choiceIds: string[] = item.choices.map((c) => c.itemId),
): VoteChoice[] {
	return choiceIds.flatMap((id) => {
		const choice = item.choices.find((c) => c.itemId === id)
		return choice ? [{ id, label: choiceLabel(choice.layerId, item.voteConfig, defaultDisplayProps) }] : []
	})
}

// sets the text of the choice for `layerId`, or clears it when `text` is blank
export function withChoiceText(config: Partial<AdvancedVoteConfig> | null, layerId: L.LayerId, text: string): Partial<AdvancedVoteConfig> {
	const others = (config?.choiceTexts ?? []).filter((c) => !L.layersEqual(c.layerId, layerId))
	const trimmed = text.trim()
	return { ...config, choiceTexts: trimmed ? [...others, { layerId, text: trimmed }] : others }
}

export namespace GenVote {
	export const CHOICE_COMPARISON_KEY = z.enum(['Size', 'Map', 'Layer', 'Gamemode', 'Unit'])
	export const DEFAULT_CHOICE_COMPARISONS: ChoiceConstraintKey[] = ['Map']
	export type ChoiceConstraintKey = z.infer<typeof CHOICE_COMPARISON_KEY>
	export type ChoiceConstraints = { [k in ChoiceConstraintKey]?: LC.InputValue }
	export function* iterChoiceCols() {
		for (const key of CHOICE_COMPARISON_KEY.options) {
			const colKeys = key === 'Unit' ? (['Unit_1', 'Unit_2'] as const) : ([key] as const)
			for (const colKey of colKeys) {
				yield [key, colKey] as const
			}
		}
	}

	export function choiceConstraintAllowedValues(key: ChoiceConstraintKey, components = L.StaticLayerComponents) {
		switch (key) {
			case 'Size':
				return components.size
			case 'Map':
				return components.maps
			case 'Layer':
				return components.layers
			case 'Gamemode':
				return components.gamemodes
			case 'Unit':
				return components.units
		}
	}

	export type Choice = {
		layerId?: L.LayerId
		choiceConstraints: ChoiceConstraints
	}
	export function initChoice(): Choice {
		return {
			choiceConstraints: {},
		}
	}
}

// What starting a vote takes. The options after `kind` apply to both kinds. A layer vote always names its queue item, so
// a start cannot land on whatever happens to be first by then.
const startVoteOptionsShape = {
	serverId: z.string(),
	voterType: VOTER_TYPE.optional(),
	// ms. Defaults to the vote item's configured duration, and then to the server's
	duration: z.number().positive().optional(),
}
export const StartVoteInputSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('layer'), itemId: z.string(), ...startVoteOptionsShape }),
	z.object({ kind: z.literal('simple'), choices: z.array(z.string()), ...startVoteOptionsShape }),
])

export function validateChoicesWithDisplayProps(_choices: L.LayerId[], displayProps: DH.LayerDisplayProp[]) {
	const chosenCols: Set<keyof L.UnvalidatedLayer> = new Set()
	if (displayProps.length === 0) displayProps = DH.LAYER_DISPLAY_PROP.options
	if (displayProps.includes('layer')) chosenCols.add('Layer').add('Map').add('Gamemode').add('LayerVersion')
	if (displayProps.includes('map')) chosenCols.add('Map')
	if (displayProps.includes('gamemode')) chosenCols.add('Gamemode')
	if (displayProps.includes('units')) chosenCols.add('Unit_1').add('Unit_2')
	if (displayProps.includes('factions')) chosenCols.add('Faction_1').add('Faction_2')
	const choices = _choices.map((c) => {
		const layer = L.toLayer(c)
		return Obj.selectProps(layer, Array.from(chosenCols))
	})
	const uniqueChoices = new Set(choices.map((c) => JSON.stringify(c)))
	return uniqueChoices.size === choices.length
}

export type StartVoteInput = z.infer<typeof StartVoteInputSchema>
export type StartVoteOpts = DistributiveOmit<StartVoteInput, 'serverId'>

export function getDefaultVoteConfig() {
	return {
		duration: ZodUtils.HumanTime.parse('120s'),
	} satisfies AdvancedVoteConfig
}

const TallyPropertiesSchema = z.object({
	votes: z.array(z.object({ playerIds: SM.PlayerIds.Schema, choice: z.string() })),
	deadline: z.number(),
})

const LayerVoteSchema = z.object({
	itemId: z.string(),
	choiceIds: z.lazy(() => z.array(LL.ItemIdSchema)),
	voterType: VOTER_TYPE,
	autostartCancelled: z.boolean().optional(),
})

export const VoteStateSchema = z.discriminatedUnion('code', [
	// the vote state doesn't have to be set to 'ready' before they're started. this is here so we can autostart votes for the next layer
	z.object({
		code: z.literal('ready'),
		...LayerVoteSchema.shape,

		autostartTime: z.date().optional(),
	}),

	z.object({
		code: z.literal('in-progress'),
		// names this run, which ending or aborting it must repeat (see V.runningVoteId)
		voteId: z.string(),
		// the plugin initiator goes first: every field of a user id is optional, so that schema would match a plugin too
		initiator: z.union([PluginInitiatorSchema, USR.GuiOrChatUserIdSchema, z.literal('autostart')]),
		...TallyPropertiesSchema.shape,
		...LayerVoteSchema.shape,
	}),
])

export type VoteState = z.infer<typeof VoteStateSchema>

export const EndingVoteStateSchema = z.discriminatedUnion('code', [
	z.object({
		code: z.literal('ended:winner'),
		winnerId: z.lazy(() => LL.ItemIdSchema),
		endedEarly: USR.GuiOrChatUserIdSchema.optional(),
		...TallyPropertiesSchema.shape,
		...LayerVoteSchema.shape,
	}),
	z.object({
		code: z.literal('ended:aborted'),
		aborter: z.union([USR.GuiOrChatUserIdSchema, z.literal('autostart')]),
		...TallyPropertiesSchema.shape,
		...LayerVoteSchema.shape,
	}),
	z.object({
		code: z.literal('ended:insufficient-votes'),
		endedEarly: USR.GuiOrChatUserIdSchema.optional(),
		...TallyPropertiesSchema.shape,
		...LayerVoteSchema.shape,
	}),
])

export type EndingVoteState = z.infer<typeof EndingVoteStateSchema>

export type VoteStateWithVoteData = Extract<
	VoteState | EndingVoteState,
	{ code: 'in-progress' | 'ended:winner' | 'ended:aborted' | 'ended:insufficient-votes' }
>

export function isVoteStateWithVoteData(state: VoteState | EndingVoteState): state is VoteStateWithVoteData {
	return (
		state.code === 'in-progress' ||
		state.code === 'ended:winner' ||
		state.code === 'ended:aborted' ||
		state.code === 'ended:insufficient-votes'
	)
}

export const TallySchema = z.object({
	totals: z.map(
		z.lazy(() => LL.ItemIdSchema),
		z.number(),
	),
	totalVotes: z.number(),
	turnoutPercentage: z.number(),
	percentages: z.map(
		z.lazy(() => LL.ItemIdSchema),
		z.number(),
	),
	leaders: z.array(z.string()),
})

export type Tally = z.infer<typeof TallySchema>

export function tallyVotes(currentVote: { choiceIds: string[]; votes: { choice: string }[] }, numPlayers: number): Tally {
	if (Object.values(currentVote.choiceIds).length == 0) {
		throw new Error('No choices listed')
	}
	const tally = new Map<string, number>()
	let leaders: string[] = []
	for (const choice of currentVote.choiceIds) {
		tally.set(choice, 0)
	}

	for (const { choice } of currentVote.votes) {
		const newVotesForChoice = tally.get(choice)! + 1

		if (leaders.length === 0) {
			leaders = [choice]
		} else if (tally.get(leaders[0]!) === newVotesForChoice) {
			leaders.push(choice)
		} else if (tally.get(leaders[0]!)! < newVotesForChoice) {
			leaders = [choice]
		}
		tally.set(choice, newVotesForChoice)
	}
	const totalVotes = currentVote.votes.length
	const percentages = new Map<string, number>()
	for (const [choice, votes] of tally.entries()) {
		percentages.set(choice, (totalVotes > 0 ? votes / totalVotes : 0) * 100)
	}
	// a server reporting no players would otherwise make this Infinity, which VOTE_ENDED cannot be read back with
	const turnoutPercentage = numPlayers > 0 ? (totalVotes / numPlayers) * 100 : 0
	return {
		totals: tally,
		totalVotes,
		turnoutPercentage,
		percentages,
		leaders: leaders,
	}
}

export type VoteStateUpdateOrInitialWithParts =
	| {
			code: 'initial-state'
			state: (VoteState & Parts<USR.UserPart>) | null
	  }
	| {
			code: 'update'
			update: (VoteStateUpdate & Parts<USR.UserPart>) | VoteCastUpdate
	  }

// One cast vote, sent to watchers in place of the whole state. The state carries every vote cast so far, so sending
// it on every cast costs each watcher the square of the turnout.
export type VoteCast = { playerIds: SM.PlayerIds.Type; choice: string }
export type VoteCastUpdate = { cast: VoteCast; source: VoteStateUpdate['source'] }

export function isVoteCastUpdate(update: VoteStateUpdate | VoteCastUpdate): update is VoteCastUpdate {
	return 'cast' in update && !('state' in update)
}

// Copies rather than mutates: the state a client holds is shared with everything rendering it.
export function applyVoteCast(state: VoteState | null, cast: VoteCast): VoteState | null {
	if (state?.code !== 'in-progress') return state
	const votes = [...state.votes]
	SM.PlayerIds.upsert(votes, ({ playerIds }) => playerIds, cast)
	return { ...state, votes }
}

export type VoteStateUpdateOrInitial =
	| {
			code: 'initial-state'
			state: VoteState | null
	  }
	| { code: 'update'; update: VoteStateUpdate }

export type VoteStateUpdate = {
	state: VoteState | null
	// the vote this update records, when it records exactly one
	cast?: VoteCast
	source:
		| {
				type: 'system'
				event:
					| 'automatic-start-vote'
					| 'vote-timeout'
					| 'ended-early'
					| 'queue-change'
					| 'next-layer-override'
					| 'app-startup'
					| 'new-game'
		  }
		| {
				type: 'manual'
				event: 'start-vote' | 'abort-vote' | 'vote' | 'queue-change' | 'autostart-cancelled'
				user: USR.GuiOrChatUserId
		  }
		| { type: 'plugin'; event: 'start-vote'; pluginId: string }
}
export type VoteStateUpdateSource = VoteStateUpdate['source']
export type VoteStateUpdateSourceEvent = VoteStateUpdateSource['event']
export type ManualVoteStateUpdateSourceEvent = Extract<VoteStateUpdateSource, { type: 'manual' }>['event']

export function getDefaultChoice(state: { choiceIds: string[] }) {
	return state.choiceIds[0]
}

export function canInitiateVote(
	itemId: string,
	queue: LL.List,
	voterType: VoterType,
	voteState?: Pick<VoteState | EndingVoteState, 'code'>,
	isEditing?: boolean,
) {
	const { index, item } = Obj.destrNullable(LL.findItemById(queue, itemId))
	if (isEditing) {
		return {
			code: 'err:editing-in-progress' as const,
		}
	}
	if (!index || !item) {
		return {
			code: 'err:item-not-found' as const,
		}
	}

	if (!LL.isVoteItem(item)) {
		return {
			code: 'err:invalid-item-type' as const,
		}
	}

	if (voterType === 'public' && index.outerIndex !== 0) {
		return {
			code: 'err:public-vote-not-first' as const,
		}
	}
	if (voteState?.code === 'in-progress') {
		return {
			code: 'err:vote-in-progress' as const,
		}
	}

	return {
		code: 'ok' as const,
		item,
	}
}

// A vote between free-text choices, started with /simplevote or from the dashboard. It runs beside the queue and never
// changes it. Choices double as their own ids, so they must be distinct.
export namespace SimpleVote {
	export const MIN_CHOICES = 2
	// one digit per choice, so a vote is cast with a single keystroke
	export const MAX_CHOICES = 9
	// a broadcast lists every choice, and Squad cuts off a long one
	export const MAX_CHOICE_LENGTH = 48

	type Base = {
		voteId: string
		voterType: VoterType
		choices: string[]
		votes: VoteCast[]
		deadline: number
		initiator: VoteInitiator
	}
	export type InProgress = Base & { code: 'in-progress' }
	type EndedBase = Base & { endedAt: number }
	export type Ended =
		| (EndedBase & { code: 'ended:winner'; winner: string; endedEarly?: USR.GuiOrChatUserId })
		| (EndedBase & { code: 'ended:insufficient-votes'; endedEarly?: USR.GuiOrChatUserId })
		| (EndedBase & { code: 'ended:aborted'; aborter: USR.GuiOrChatUserId })
	export type State = InProgress | Ended

	// how long the dashboard keeps showing a simple vote after it ends
	export const RESULT_SHOWN_MS = 15 * 60 * 1000

	export type Update = { code: 'state'; state: State | null } | { code: 'cast'; voteId: string; cast: VoteCast }

	export function tally(state: State, numPlayers: number): Tally {
		return tallyVotes({ choiceIds: state.choices, votes: state.votes }, numPlayers)
	}

	// Copies rather than mutates, as applyVoteCast does. A cast for an earlier vote is dropped.
	export function applyUpdate(state: State | null, update: Update): State | null {
		if (update.code === 'state') return update.state
		if (state?.code !== 'in-progress' || state.voteId !== update.voteId) return state
		const votes = [...state.votes]
		SM.PlayerIds.upsert(votes, ({ playerIds }) => playerIds, update.cast)
		return { ...state, votes }
	}

	// Commas separate the choices when there are any. Otherwise each word is a choice, and an underscore stands in for a
	// space inside one.
	export function choicesFromText(text: string): string[] {
		const choices = text.includes(',')
			? text.split(',').map((choice) => choice.trim().replace(/\s+/g, ' '))
			: text.split(/\s+/).map((word) => word.replaceAll('_', ' ').trim())
		return choices.filter((choice) => choice.length > 0)
	}

	export type ChoicesError =
		| { code: 'err:too-few-choices' }
		| { code: 'err:too-many-choices' }
		| { code: 'err:choice-too-long'; choice: string }
		| { code: 'err:duplicate-choice'; choice: string }

	export function validateChoices(choices: string[]): ChoicesError | null {
		if (choices.length < MIN_CHOICES) return { code: 'err:too-few-choices' }
		if (choices.length > MAX_CHOICES) return { code: 'err:too-many-choices' }
		const seen = new Set<string>()
		for (const choice of choices) {
			if (choice.length > MAX_CHOICE_LENGTH) return { code: 'err:choice-too-long', choice }
			const key = choice.toLowerCase()
			if (seen.has(key)) return { code: 'err:duplicate-choice', choice }
			seen.add(key)
		}
		return null
	}

	export type Payload = {
		// written only through vote.server's setters, which keep two votes from running at once (see runningVote)
		readonly state: State | null
		endTask: Rx.Subscription | null
		// the VOTE_STARTED of the simple vote in progress, which its reminder broadcasts are attributed to
		startedEventId: string | null
		update$: Rx.Subject<Update>
	}
}

export const VOTE_KINDS = ['layer', 'simple'] as const
// The vote taking numbers from chat. Both kinds read them, so at most one runs at a time.
export type RunningVote = (typeof VOTE_KINDS)[number]

// how a vote finished: a winner chosen, too few votes cast to choose one, or stopped without a result
export const VOTE_OUTCOMES = ['winner', 'insufficient-votes', 'aborted'] as const
export type VoteOutcome = (typeof VOTE_OUTCOMES)[number]

export function runningVote(vote: Pick<Ctx.Payload, 'state' | 'simple'>): RunningVote | null {
	if (vote.state?.code === 'in-progress') return 'layer'
	if (vote.simple.state?.code === 'in-progress') return 'simple'
	return null
}

// -------- a vote as the dashboard shows it, whichever kind it is --------

export type VoteView = {
	kind: RunningVote
	// unique per run: a layer vote that was aborted can be run again on the same item
	key: string
	// what ending or aborting this vote names it by, while it runs
	voteId: string | null
	code: 'in-progress' | 'ended:winner' | 'ended:insufficient-votes' | 'ended:aborted'
	choices: { id: string; label: string }[]
	votes: { choice: string }[]
	deadline: number
	winnerId?: string
}

// The layer vote running on the queue, or else the queue head's vote once it has ended, until a match starts after it.
export function layerVoteView(
	list: LL.List,
	state: VoteState | null,
	defaultDisplayProps: DH.LayerDisplayProp[],
	currentMatchStart: Date | undefined,
): VoteView | null {
	let item: LL.Item | undefined
	let voteData: VoteStateWithVoteData | undefined
	if (state?.code === 'in-progress') {
		item = LL.findItemById(list, state.itemId)?.item
		voteData = state
	} else {
		item = list[0]
		voteData = item && LL.isVoteItem(item) ? item.endingVoteState : undefined
	}
	if (!item || !LL.isVoteItem(item) || !voteData) return null
	if (voteData.code !== 'in-progress' && currentMatchStart && voteData.deadline < currentMatchStart.getTime()) return null
	return {
		kind: 'layer',
		key: `layer:${item.itemId}:${voteData.deadline}`,
		voteId: voteData.code === 'in-progress' ? voteData.voteId : null,
		code: voteData.code,
		choices: voteItemChoices(item, defaultDisplayProps, voteData.choiceIds),
		votes: voteData.votes,
		deadline: voteData.deadline,
		winnerId: voteData.code === 'ended:winner' ? voteData.winnerId : undefined,
	}
}

export function simpleVoteView(state: SimpleVote.State): VoteView {
	return {
		kind: 'simple',
		key: `simple:${state.voteId}`,
		voteId: state.code === 'in-progress' ? state.voteId : null,
		code: state.code,
		choices: state.choices.map((choice) => ({ id: choice, label: choice })),
		votes: state.votes,
		deadline: state.deadline,
		winnerId: state.code === 'ended:winner' ? state.winner : undefined,
	}
}

// The running vote, or else the one that ended last.
export function shownVote(views: (VoteView | null)[]): VoteView | null {
	let shown: VoteView | null = null
	for (const view of views) {
		if (!view) continue
		if (view.code === 'in-progress') return view
		if (!shown || view.deadline > shown.deadline) shown = view
	}
	return shown
}

export function tallyView(view: VoteView, numPlayers: number): Tally {
	return tallyVotes({ choiceIds: view.choices.map((c) => c.id), votes: view.votes }, numPlayers)
}

// The id of the vote taking numbers from chat. Ending or aborting a vote names it by this id, so a request made against
// one vote can never end another that started since.
export function runningVoteId(vote: Pick<Ctx.Payload, 'state' | 'simple'>): string | null {
	if (vote.state?.code === 'in-progress') return vote.state.voteId
	if (vote.simple.state?.code === 'in-progress') return vote.simple.state.voteId
	return null
}

export const EndVoteInputSchema = z.object({ serverId: z.string(), voteId: z.string() })

export type Ctx = CS.Ctx & { vote: Ctx.Payload } & CS.ServerId
export const CtxDef = CD.defCtx<Ctx>()(['vote'], { name: 'vote', extends: [CS.ServerIdDef] })

export namespace Ctx {
	export type Payload = {
		voteEndTask: Rx.Subscription | null
		autostartVoteSub: Rx.Subscription | null
		mtx: MutexInterface
		// written only through vote.server's setters, which keep two votes from running at once (see runningVote)
		readonly state: VoteState | null
		// the VOTE_STARTED of the vote in progress, which its reminder broadcasts are attributed to
		startedEventId: string | null
		update$: Rx.Subject<VoteStateUpdate>
		simple: SimpleVote.Payload
	}
}
