import * as AppliedFiltersPrt from '@/frame-partials/applied-filters.partial'
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
	cursor?: LQY.Cursor
	colConfig: LQY.EffectiveColumnAndTableConfig
}

export type Types = {
	name: 'genVote'
	key: FRM.RawInstanceKey<{ instanceId: string }>
	input: Input
	state: Store
}

export function createInput(opts?: { cursor?: LQY.Cursor }): Input {
	return {
		instanceId: createId(4),
		colConfig: ConfigClient.getColConfig(),
		cursor: opts?.cursor,
	}
}

export type Result = {
	choices: L.LayerId[]
	voteConfig: Partial<V.AdvancedVoteConfig>
	displayProps?: DH.LayerDisplayProp[]
}

type Primary = {
	cursor?: LQY.Cursor
	setCursor: (cursor: LQY.Cursor) => void
	choices: LQY.GenVote.Choice[]
	chosenLayers: Record<string, LayerQueriesClient.RowData | undefined>
	choiceErrors: (string | undefined)[]
	setChoiceConstraint: (index: number, key: LQY.GenVote.ChoiceConstraintKey, value: LC.InputValue) => void
	deleteChoiceConstraints: (keys: LQY.GenVote.ChoiceConstraintKey[]) => void
	addChoice: () => void
	removeChoice: (index: number) => void
	regen(choiceIndex?: number): Promise<void>
	generating: boolean
	includedConstraints: LQY.GenVote.ChoiceConstraintKey[]
	uniqueConstraints: LQY.GenVote.ChoiceConstraintKey[]
	addIncludedConstraint: (key: LQY.GenVote.ChoiceConstraintKey) => void
	removeIncludedConstraint: (key: LQY.GenVote.ChoiceConstraintKey) => void
	addUniqueConstraint: (key: LQY.GenVote.ChoiceConstraintKey) => void
	removeUniqueConstraint: (key: LQY.GenVote.ChoiceConstraintKey) => void
	voteConfig: Partial<V.AdvancedVoteConfig>
	displayProps?: DH.LayerDisplayProp[]
	displayPropsManuallySet: boolean
	setVoteConfig: (update: Partial<V.AdvancedVoteConfig>) => void
	setDisplayProps: (displayProps: DH.LayerDisplayProp[] | null, manuallySet?: boolean) => void
	result: Result | null
}

type Store =
	& Primary
	& AppliedFiltersPrt.Store
	& PoolCheckboxesPrt.Store

function constraintsToDisplayProps(constraints: LQY.GenVote.ChoiceConstraintKey[]): DH.LayerDisplayProp[] | undefined {
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
			setCursor: (cursor: LQY.Cursor) => {
				set({ cursor })
			},

			chosenLayers: {},
			choiceErrors: [],
			choices: Array.from(Gen.map(Gen.range(V.DEFAULT_NUM_CHOICES), () => LQY.GenVote.initChoice())),
			voteConfig: {},
			displayProps: constraintsToDisplayProps(LQY.GenVote.DEFAULT_CHOICE_COMPARISONS),
			displayPropsManuallySet: false,
			setVoteConfig: (update: Partial<V.AdvancedVoteConfig>) => {
				set({
					voteConfig: { ...get().voteConfig, ...update },
				})
			},
			setDisplayProps: (displayProps: DH.LayerDisplayProp[] | null, manuallySet = true) => {
				set({
					displayProps: displayProps ?? undefined,
					displayPropsManuallySet: manuallySet,
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
					choices: [...get().choices, LQY.GenVote.initChoice()],
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
			regen: async (omitIndex?: number) => {
				let state = get()
				set({ generating: true })
				try {
					const startingChoices = state.choices.map((c, i) =>
						(omitIndex === undefined || i === omitIndex) ? ({ ...c, layerId: undefined }) : c
					)
					const base = selectBaseQueryInput(state)

					const res = await LayerQueriesClient.generateVote({
						...base,
						choices: startingChoices,
						uniqueConstraints: state.uniqueConstraints,
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
							displayProps: get().displayProps,
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
			includedConstraints: LQY.GenVote.DEFAULT_CHOICE_COMPARISONS,
			uniqueConstraints: LQY.GenVote.DEFAULT_CHOICE_COMPARISONS,
			addIncludedConstraint: (key) => {
				if (get().includedConstraints.includes(key)) return
				const newConstraints = [...get().includedConstraints, key]
				const update: Partial<Store> = {
					includedConstraints: newConstraints,
				}
				// Auto-sync displayProps if not manually set
				if (!get().displayPropsManuallySet) {
					update.displayProps = constraintsToDisplayProps(newConstraints)
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
					update.displayProps = constraintsToDisplayProps(newConstraints)
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
	PoolCheckboxesPrt.initNewPoolCheckboxes({ ...args, input: { defaultState: { dnr: 'disabled' } } })
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
