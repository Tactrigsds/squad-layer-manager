import * as AppliedFiltersPrt from '@/frame-partials/applied-filters.partial'

export type { PostProcessedLayer } from '@/systems/layer-queries.shared'
import * as PoolCheckboxesPrt from '@/frame-partials/pool-checkboxes.partial'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import type * as DH from '@/lib/display-helpers'
import type * as FRM from '@/lib/frame'
import * as Gen from '@/lib/generator'
import { createId } from '@/lib/id'
import * as ZusUtils from '@/lib/zustand'
import type * as L from '@/models/layer'
import type * as LC from '@/models/layer-columns'
import type * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import * as V from '@/models/vote.models'
import * as ConfigClient from '@/systems/config.client'
import * as LayerQueriesClient from '@/systems/layer-queries.client'
import * as Im from 'immer'

import { frameManager } from './frame-manager'
export type SelectType = 'generic' | 'indexed'
export type Key = FRM.InstanceKey<Types>
export type KeyProp = FRM.KeyProp<Types>
export type Frame = FRM.Frame<Types>
export type Input = {
	instanceId: string
	cursor?: LL.Cursor
	colConfig: LQY.EffectiveColumnAndTableConfig
	server: SquadServerFrame.Key
}
export type Types = {
	name: 'genVote'
	key: FRM.RawInstanceKey<{ instanceId: string }>
	input: Input
	state: Store
}

export function createInput(opts: { cursor?: LL.Cursor; server: SquadServerFrame.Key }): Input {
	return {
		instanceId: createId(4),
		colConfig: ConfigClient.getColConfig(),
		cursor: opts?.cursor,
		server: opts.server,
	}
}

export type Result = {
	choices: L.LayerId[]
	voteConfig: Partial<V.AdvancedVoteConfig>
}

type Primary = {
	cursor?: LL.Cursor
	server: SquadServerFrame.Key
	choices: V.GenVote.Choice[]
	chosenLayers: Record<string, LayerQueriesClient.RowData | undefined>
	choiceErrors: (string | undefined)[]
	generating: boolean
	includedConstraints: V.GenVote.ChoiceConstraintKey[]
	uniqueConstraints: V.GenVote.ChoiceConstraintKey[]
	voteConfig: Partial<V.AdvancedVoteConfig>
	displayPropsManuallySet: boolean
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
	const set = args.set

	set(
		{
			cursor: args.input.cursor,
			server: args.input.server,

			chosenLayers: {},
			choiceErrors: [],
			choices: Array.from(Gen.map(Gen.range(V.DEFAULT_NUM_CHOICES), () => V.GenVote.initChoice())),
			voteConfig: {
				displayProps: constraintsToDisplayProps(V.GenVote.DEFAULT_CHOICE_COMPARISONS),
			},
			displayPropsManuallySet: false,
			generating: false,
			result: null,
			includedConstraints: V.GenVote.DEFAULT_CHOICE_COMPARISONS,
			uniqueConstraints: V.GenVote.DEFAULT_CHOICE_COMPARISONS,
		} satisfies Primary,
	)

	// the applied-filters partial reads squadServer from state to seed the pool's configured filters; without
	// this its predicate is unset and pool filters never apply in the gen-vote dialog
	set({ squadServer: args.input.server } satisfies AppliedFiltersPrt.Predicates)
	AppliedFiltersPrt.initAppliedFiltersStore({ ...args, input: { poolDefaultDisabled: false } })
	PoolCheckboxesPrt.initNewPoolCheckboxes({ ...args, input: { defaultState: { dnr: 'inverted' } } })
}

export const frame: Frame = frameManager.createFrame<Types>({
	name: 'genVote',
	createKey,
	setup,
})

export namespace Sel {
	const EMPTY_LAYER_ITEMS = LQY.initLayerItemsState()
	export function baseQueryInput(state: Store, squadServer?: SquadServerFrame.State) {
		const appliedConstraints = AppliedFiltersPrt.Sel.constraints(state)
		const settings = SquadServerFrame.Sel.settingsOrDefault(squadServer)
		const repeatRuleConstraints = PoolCheckboxesPrt.getToggledRepeatRuleConstraints(settings, state.poolCheckboxes.checkboxesState.dnr)

		const base: LQY.BaseQueryInput = {
			cursor: state.cursor,
			action: 'add',
			constraints: [
				...appliedConstraints,
				...repeatRuleConstraints,
			],
			list: squadServer?.layerItemsState ?? EMPTY_LAYER_ITEMS,
		}
		return base
	}

	export function queryInput(
		state: Store,
		squadServer: SquadServerFrame.State | undefined,
		omitIndex: number,
	): LQY.GenVote.Input {
		const base = baseQueryInput(state, squadServer)
		const startingChoices = state.choices.map((c, i) => (omitIndex === undefined || i === omitIndex) ? ({ ...c, layerId: undefined }) : c)

		return {
			...base,
			choices: startingChoices,
			uniqueConstraints: state.uniqueConstraints,
		}
	}
}

export namespace Actions {
	function store(stores: KeyProp) {
		return ZusUtils.resolveStore<Store>(stores.genVote)
	}

	export function setCursor(stores: KeyProp, cursor: LL.Cursor) {
		store(stores).setState({ cursor })
	}

	export function setVoteConfig(stores: KeyProp, update: Partial<V.AdvancedVoteConfig>) {
		const s = store(stores)
		s.setState({ voteConfig: { ...s.getState().voteConfig, ...update } })
	}

	export function setChoiceConstraint(stores: KeyProp, index: number, key: V.GenVote.ChoiceConstraintKey, value: LC.InputValue) {
		const s = store(stores)
		s.setState({
			choices: Im.produce(s.getState().choices, draft => {
				draft[index].choiceConstraints[key] = value
			}),
		})
	}

	export function setChoiceLayer(stores: KeyProp, index: number, layerId: L.LayerId) {
		const s = store(stores)
		const state = s.getState()
		const choices = Im.produce(state.choices, draft => {
			draft[index].layerId = layerId
		})
		const choiceErrors = Im.produce(state.choiceErrors, draft => {
			draft[index] = undefined
		})
		let result: Store['result'] = null
		if (choices.every(c => c.layerId)) {
			result = {
				choices: choices.map(c => c.layerId!),
				voteConfig: state.voteConfig,
			}
		}
		s.setState({ choices, choiceErrors, result })
	}

	export function addChoice(stores: KeyProp) {
		const s = store(stores)
		s.setState({ choices: [...s.getState().choices, V.GenVote.initChoice()] })
	}

	export function removeChoice(stores: KeyProp, index: number) {
		const s = store(stores)
		const choices = s.getState().choices
		if (choices.length <= 2) return // Minimum 2 choices for a vote
		s.setState({ choices: choices.filter((_, i) => i !== index) })
	}

	export async function regen(stores: KeyProp & Partial<SquadServerFrame.KeyProp>, onlyIndex?: number) {
		const s = store(stores)
		const squadServer = stores.squadServer
		s.setState({ generating: true })
		const state = s.getState()
		try {
			const startingChoices = state.choices.map((c, i) => (onlyIndex === undefined || i === onlyIndex) ? ({ ...c, layerId: undefined }) : c)
			const base = Sel.baseQueryInput(state, ZusUtils.getState(squadServer))

			const res = await LayerQueriesClient.generateVote({
				...base,
				choices: startingChoices,
				uniqueConstraints: state.uniqueConstraints,
				onlyIndex,
			})
			if (res.code === 'err:invalid-node') throw new Error(JSON.stringify(res.errors))
			if (res.code === 'err:missing-item-states') throw new Error(res.code)
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
					voteConfig: s.getState().voteConfig,
				}
			}

			s.setState({
				chosenLayers: chosenLayersMap,
				choiceErrors: res.choiceErrors ?? [],
				choices,
				result,
				generating: false,
			})
		} finally {
			s.setState({ generating: false })
		}
	}

	export function addIncludedConstraint(stores: KeyProp, key: V.GenVote.ChoiceConstraintKey) {
		const s = store(stores)
		if (s.getState().includedConstraints.includes(key)) return
		const newConstraints = [...s.getState().includedConstraints, key]
		const update: Partial<Store> = {
			includedConstraints: newConstraints,
		}
		// Auto-sync displayProps if not manually set
		if (!s.getState().displayPropsManuallySet) {
			update.voteConfig ??= s.getState().voteConfig
			update.voteConfig.displayProps = constraintsToDisplayProps(newConstraints)
		}
		s.setState(update)
	}

	export function removeIncludedConstraint(stores: KeyProp, key: V.GenVote.ChoiceConstraintKey) {
		const s = store(stores)
		const newConstraints = s.getState().includedConstraints.filter(k => k !== key)
		const update: Partial<Store> = {
			includedConstraints: newConstraints,
			choices: Im.produce(s.getState().choices, draft => {
				for (const choice of draft) {
					delete choice.choiceConstraints[key]
				}
			}),
			uniqueConstraints: s.getState().uniqueConstraints.filter(k => k !== key),
		}
		// Auto-sync displayProps if not manually set
		if (!s.getState().displayPropsManuallySet) {
			update.voteConfig ??= s.getState().voteConfig
			update.voteConfig.displayProps = constraintsToDisplayProps(newConstraints)
		}
		s.setState(update)
	}

	export function addUniqueConstraint(stores: KeyProp, key: V.GenVote.ChoiceConstraintKey) {
		const s = store(stores)
		if (s.getState().uniqueConstraints.includes(key)) return
		s.setState({ uniqueConstraints: [...s.getState().uniqueConstraints, key] })
	}

	export function removeUniqueConstraint(stores: KeyProp, key: V.GenVote.ChoiceConstraintKey) {
		const s = store(stores)
		s.setState({ uniqueConstraints: s.getState().uniqueConstraints.filter(k => k !== key) })
	}
}
