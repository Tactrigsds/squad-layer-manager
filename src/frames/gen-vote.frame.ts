import * as AppliedFiltersPrt from '@/frame-partials/applied-filters.partial'
import * as FB from '@/models/filter-builders'
export type { PostProcessedLayer } from '@/systems/layer-queries.shared'
import * as LayerFilterMenuPrt from '@/frame-partials/layer-filter-menu.partial'
import * as LayerTablePrt from '@/frame-partials/layer-table.partial'
import * as PoolCheckboxesPrt from '@/frame-partials/pool-checkboxes.partial'
import * as DH from '@/lib/display-helpers'
import type * as FRM from '@/lib/frame'
import * as Gen from '@/lib/generator'
import { createId } from '@/lib/id'
import * as Obj from '@/lib/object'
import * as CS from '@/models/context-shared'
import * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import * as V from '@/models/vote.models'
import * as ConfigClient from '@/systems/config.client'
import * as LayerQueriesClient from '@/systems/layer-queries.client'
import * as QD from '@/systems/queue-dashboard.client'
import * as ServerSettingsClient from '@/systems/server-settings.client'
import * as Im from 'immer'
import * as Rx from 'rxjs'
import { frameManager } from './frame-manager'

export type SelectType = 'generic' | 'indexed'
export type Key = FRM.InstanceKey<Types>
export type KeyProp = FRM.KeyProp<Types>
export type Frame = FRM.Frame<Types>
export type Input = {
	instanceId: string
	cursor?: LL.Cursor
	colConfig: LQY.EffectiveColumnAndTableConfig
}

export type Types = {
	name: 'genVote'
	key: FRM.RawInstanceKey<{ instanceId: string }>
	input: Input
	state: Store
}

export function createInput(opts?: { cursor?: LL.Cursor }): Input {
	return {
		instanceId: createId(4),
		colConfig: ConfigClient.getColConfig(),
		cursor: opts?.cursor,
	}
}

export type Result = {
	choices: L.LayerId[]
	voteConfig: Partial<V.AdvancedVoteConfig>
	cursor?: LL.Cursor
}

type Primary = {
	cursor?: LL.Cursor
	setCursor: (cursor: LL.Cursor) => void
	choices: V.GenVote.Choice[]
	chosenLayers: Record<string, LayerQueriesClient.RowData | undefined>
	choiceErrors: (string | undefined)[]
	setChoiceConstraint: (index: number, key: V.GenVote.ChoiceConstraintKey, value: LC.InputValue) => void
	deleteChoiceConstraints: (keys: V.GenVote.ChoiceConstraintKey[]) => void
	addChoice: () => void
	removeChoice: (index: number) => void
	regen(choiceIndex?: number): Promise<void>
	generating: boolean
	includedConstraints: V.GenVote.ChoiceConstraintKey[]
	uniqueConstraints: V.GenVote.ChoiceConstraintKey[]
	addIncludedConstraint: (key: V.GenVote.ChoiceConstraintKey) => void
	removeIncludedConstraint: (key: V.GenVote.ChoiceConstraintKey) => void
	addUniqueConstraint: (key: V.GenVote.ChoiceConstraintKey) => void
	removeUniqueConstraint: (key: V.GenVote.ChoiceConstraintKey) => void
	voteConfig: Partial<V.AdvancedVoteConfig>
	displayPropsManuallySet: boolean
	setVoteConfig: (update: Partial<V.AdvancedVoteConfig>) => void
	result: Result | null
}

type Store =
	& Primary
	& AppliedFiltersPrt.Store
	& PoolCheckboxesPrt.Store

function constraintsToDisplayProps(constraints: V.GenVote.ChoiceConstraintKey[]): DH.LayerDisplayProp[] | undefined {
	const props: DH.LayerDisplayProp[] = []

	if (constraints.includes('Map')) {
		props.push('map')
	}
	if (constraints.includes('Gamemode')) {
		props.push('gamemode')
	}
	if (constraints.includes('Size')) {
		props.push('map')
	}
	if (constraints.includes('Unit')) {
		props.push('units')
	}

	// If no constraints are selected, return undefined to use defaults
	if (props.length === 0) return undefined

	return props
}

const createKey: Frame['createKey'] = (frameId, input) => ({ frameId, instanceId: input.instanceId })
const setup: Frame['setup'] = (args) => {
	const get = args.get
	const set = args.set
	const input = args.input
	const colConfig = input.colConfig

	set(
		{
			cursor: args.input.cursor,
			setCursor: (cursor: LL.Cursor) => {
				set({ cursor })
			},

			chosenLayers: {},
			choiceErrors: [],
			choices: Array.from(Gen.map(Gen.range(V.DEFAULT_NUM_CHOICES), () => V.GenVote.initChoice())),
			voteConfig: {
				displayProps: constraintsToDisplayProps(V.GenVote.DEFAULT_CHOICE_COMPARISONS),
			},
			displayPropsManuallySet: false,
			setVoteConfig: (update: Partial<V.AdvancedVoteConfig>) => {
				set({
					voteConfig: { ...get().voteConfig, ...update },
				})
			},
			setChoiceConstraint: (index, key, value) => {
				set({
					choices: Im.produce(get().choices, draft => {
						draft[index].choiceConstraints[key] = value
					}),
				})
			},
			deleteChoiceConstraints: (keys) => {
			},
			addChoice: () => {
				set({
					choices: [...get().choices, V.GenVote.initChoice()],
				})
			},
			removeChoice: (index: number) => {
				const choices = get().choices
				if (choices.length <= 2) return // Minimum 2 choices for a vote
				set({
					choices: choices.filter((_, i) => i !== index),
				})
			},

			generating: false,
			regen: async (onlyIndex?: number) => {
				let state = get()
				set({ generating: true })
				try {
					const startingChoices = state.choices.map((c, i) =>
						(onlyIndex === undefined || i === onlyIndex) ? ({ ...c, layerId: undefined }) : c
					)
					const base = selectBaseQueryInput(state)

					const res = await LayerQueriesClient.generateVote({
						...base,
						choices: startingChoices,
						uniqueConstraints: state.uniqueConstraints,
						onlyIndex,
					})
					if (res.code !== 'ok') throw new Error(JSON.stringify(res.errors))
					const chosenLayersMap: Record<string, LayerQueriesClient.RowData | undefined> = { ...state.chosenLayers }
					for (const layer of res.chosenLayers) {
						if (!layer) continue
						chosenLayersMap[layer.id] = layer
					}
					let result: Store['result'] = null
					const choices = startingChoices.map((c, i) => ({ ...c, layerId: res.chosenLayers[i]?.id ?? c.layerId }))
					if (choices.every(c => c.layerId)) {
						result = {
							choices: choices.map(c => c.layerId!),
							voteConfig: get().voteConfig,
							cursor: get().cursor,
						}
					}

					set({
						chosenLayers: chosenLayersMap,
						choiceErrors: res.choiceErrors ?? [],
						choices,
						result,
						generating: false,
					})
				} finally {
					set({ generating: false })
				}
			},
			result: null,
			includedConstraints: V.GenVote.DEFAULT_CHOICE_COMPARISONS,
			uniqueConstraints: V.GenVote.DEFAULT_CHOICE_COMPARISONS,
			addIncludedConstraint: (key) => {
				if (get().includedConstraints.includes(key)) return
				const newConstraints = [...get().includedConstraints, key]
				const update: Partial<Store> = {
					includedConstraints: newConstraints,
				}
				// Auto-sync displayProps if not manually set
				if (!get().displayPropsManuallySet) {
					update.voteConfig ??= get().voteConfig
					update.voteConfig.displayProps = constraintsToDisplayProps(newConstraints)
				}
				set(update)
			},
			removeIncludedConstraint: (key) => {
				const newConstraints = get().includedConstraints.filter(k => k !== key)
				const update: Partial<Store> = {
					includedConstraints: newConstraints,
					choices: Im.produce(get().choices, draft => {
						for (const choice of draft) {
							delete choice.choiceConstraints[key]
						}
					}),
				}
				// Auto-sync displayProps if not manually set
				if (!get().displayPropsManuallySet) {
					update.voteConfig ??= get().voteConfig
					update.voteConfig.displayProps = constraintsToDisplayProps(newConstraints)
				}
				set(update)
			},
			addUniqueConstraint: (key) => {
				if (get().uniqueConstraints.includes(key)) return
				set({
					uniqueConstraints: [...get().uniqueConstraints, key],
				})
			},
			removeUniqueConstraint: (key) => {
				set({
					uniqueConstraints: get().uniqueConstraints.filter(k => k !== key),
				})
			},
		} satisfies Primary,
	)
	AppliedFiltersPrt.initAppliedFiltersStore({ ...args, input: { poolDefaultDisabled: false } })
	PoolCheckboxesPrt.initNewPoolCheckboxes({ ...args, input: { defaultState: { dnr: 'inverted' } } })
}

export const frame: Frame = frameManager.createFrame<Types>({
	name: 'genVote',
	createKey,
	setup,
})

export function selectBaseQueryInput(state: Store) {
	const appliedConstraints = AppliedFiltersPrt.getAppliedFiltersConstraints(state)
	const settings = ServerSettingsClient.Store.getState().saved
	const repeatRuleConstraints = QD.getToggledRepeatRuleConstraints(settings, state.checkboxesState.dnr)

	const base: LQY.BaseQueryInput = {
		cursor: state.cursor,
		action: 'add',
		constraints: [
			...appliedConstraints,
			...repeatRuleConstraints,
		],
	}
	return base
}

export function selectQueryInput(state: Store, omitIndex: number): LQY.GenVote.Input {
	const base = selectBaseQueryInput(state)
	const startingChoices = state.choices.map((c, i) => (omitIndex === undefined || i === omitIndex) ? ({ ...c, layerId: undefined }) : c)

	return {
		...base,
		choices: startingChoices,
		uniqueConstraints: state.uniqueConstraints,
	}
}
