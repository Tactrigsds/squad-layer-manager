import * as Icons from 'lucide-react'
import React from 'react'

import { Button } from '@/components/ui/button'
import * as LayerFilterMenuPrt from '@/frame-partials/layer-filter-menu.partial'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand.ts'
import * as F_Msgs from '@/messages/filter.messages'
import * as LC_Msgs from '@/messages/layer-columns.messages'
import * as L_Msgs from '@/messages/layer.messages'
import * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as VEH from '@/models/vehicles.models'
import * as ConfigClient from '@/systems/config.client'
import { tr } from '@/systems/messages.client'

import ComboBox from './combo-box/combo-box.tsx'
import type { ComparisonHandle } from './filter-card'
import { Comparison } from './filter-card'

const MATCHUP_ROWS = F.TEAM_COLUMNS.map((column) => ({
	label: F_Msgs.teamColumnNames[column],
	team1: F.resolveTeamColumn(column, 1),
	team2: F.resolveTeamColumn(column, 2),
}))
const TEAM_FIELDS = MATCHUP_ROWS.flatMap((row) => [row.team1, row.team2])

/**
 * The constraint rail: one row per field with a symbol-width operator and a value select, and the team
 * fields folded into one matchup node (an operator per dimension, a select per side, swap between the sides).
 */
export default function LayerFilterMenu(props: { stores: LayerFilterMenuPrt.PredicatedKeyProp; className?: string }) {
	const fields = Zus.useStore(
		props.stores.filterMenu,
		Zus.useShallow((s) => Object.keys(s.filterMenu.menuItems)),
	)
	const hasTeamFields = TEAM_FIELDS.some((f) => fields.includes(f))
	// the matchup sits where the first team field would have
	const firstTeamIndex = fields.findIndex((f) => TEAM_FIELDS.includes(f))

	return (
		<div className={cn('flex flex-col gap-1.5', props.className)}>
			{fields.map((field, i) => {
				if (TEAM_FIELDS.includes(field)) {
					return i === firstTeamIndex && hasTeamFields ? <MatchupNode key="matchup" stores={props.stores} /> : null
				}
				return <LayerFilterMenuItem key={field} field={field} stores={props.stores} />
			})}
			<Button
				size="sm"
				className="mt-1"
				onClick={() => {
					LayerFilterMenuPrt.Actions.resetAllFilters(props.stores)
				}}
			>
				<Icons.Trash />
				{tr.text(F_Msgs.clearAll())}
			</Button>
		</div>
	)
}

function useMenuItem(field: string, stores: LayerFilterMenuPrt.PredicatedKeyProp) {
	const ref = React.useRef<ComparisonHandle>(null)
	const [possibleValues, comp] = Zus.useStore(
		stores.filterMenu,
		Zus.useDeep((state) => [state.filterMenuItemPossibleValues?.[field], state.filterMenu.menuItems[field]] as const),
	)
	React.useEffect(() => {
		const sub = Zus.getState(stores.filterMenu).filterMenu.clearAll$.subscribe(() => {
			ref.current?.clear(true)
		})
		return () => sub.unsubscribe()
	}, [stores])
	const clear = () => {
		LayerFilterMenuPrt.Actions.resetFilter(stores, field)
		ref.current?.clear(true)
	}
	return { ref, possibleValues, comp, clear }
}

// resetAllConstraints is a Predicate set up by the owning frame (select-layers / gen-vote), not part of
// LayerFilterMenuPrt's own Key type, but always present on the concrete frame state at runtime.
const unlockAllValues = (stores: LayerFilterMenuPrt.PredicatedKeyProp) => () => Zus.getState(stores.filterMenu).resetAllConstraints()

const CLEAR_BUTTON = 'w-5! shrink-0 text-text-3 data-[empty=true]:invisible'

function LayerFilterMenuItem(props: { field: string; stores: LayerFilterMenuPrt.PredicatedKeyProp }) {
	const { ref, possibleValues, comp, clear } = useMenuItem(props.field, props.stores)
	const hasValue = F.editableCompHasValue(comp)
	const colDef = LC.getColumnDef(props.field)
	const name = colDef ? tr.text(LC_Msgs.columnName(colDef)) : props.field
	const label = colDef?.shortName ?? name

	return (
		<div className="grid grid-cols-[72px_36px_minmax(0,1fr)_20px] items-center gap-1 [&_button[role=combobox]]:w-full [&_button[role=combobox]]:min-w-0">
			<span className="text-xs text-text-2 whitespace-nowrap truncate" title={name}>
				{label}
			</span>
			<Comparison
				ref={ref}
				columnEditable={false}
				showColumn={false}
				operatorClassName="w-9 justify-center px-0! font-mono text-text-2 [&>span]:overflow-visible"
				numericValueClassName="w-[58px]"
				highlight={hasValue}
				node={comp}
				allowedEnumValues={possibleValues}
				onSetAllValuesAllowed={unlockAllValues(props.stores)}
				onSetAllValuesAllowedLabel={tr.text(F_Msgs.clearOtherFilters())}
				setNode={(update) => LayerFilterMenuPrt.Actions.setComparison(props.stores, props.field, update)}
				lockOnSingleOption
			/>
			<Button
				data-empty={!hasValue}
				variant="ghost"
				size="icon-sm"
				className={CLEAR_BUTTON}
				title={tr.text(F_Msgs.clearFilter(label))}
				onClick={clear}
			>
				<Icons.Trash />
			</Button>
		</div>
	)
}

function MatchupNode(props: { stores: LayerFilterMenuPrt.PredicatedKeyProp }) {
	const swapFactionsDisabled = Zus.useStore(props.stores.filterMenu, LayerFilterMenuPrt.Sel.swapFactionsDisabled)
	// the vehicle rows also need the artifact's vehicle tables: a picker over an empty enum is worse than no picker
	const hasVehicleData = VEH.hasVehicleData(L.StaticLayerComponents)
	const rows = Zus.useStore(
		props.stores.filterMenu,
		Zus.useShallow((s) =>
			MATCHUP_ROWS.filter(
				(row) =>
					s.filterMenu.menuItems[row.team1] &&
					s.filterMenu.menuItems[row.team2] &&
					(hasVehicleData || !LC.vehicleColumnInfo(row.team1)),
			),
		),
	)
	const anySet = Zus.useStore(props.stores.filterMenu, (s) =>
		TEAM_FIELDS.some((f) => s.filterMenu.menuItems[f] && F.editableCompHasValue(s.filterMenu.menuItems[f])),
	)
	const clearAll = () => {
		for (const field of TEAM_FIELDS) LayerFilterMenuPrt.Actions.resetFilter(props.stores, field)
	}
	return (
		<div className="grid grid-cols-[72px_36px_minmax(0,1fr)_minmax(0,1fr)_20px] items-center gap-1 [&_button[role=combobox]]:w-full [&_button[role=combobox]]:min-w-0">
			<span className="text-xs text-text-2 whitespace-nowrap">{tr.text(F_Msgs.matchup())}</span>
			<span />
			<div className="col-span-2 grid grid-cols-[1fr_auto_1fr] items-center gap-1 text-2xs font-bold text-text-3 fd-cond uppercase tracking-wider">
				<span>{tr.text(L_Msgs.teamName(1))}</span>
				<Button
					title={tr.text(F_Msgs.swapFactions())}
					disabled={swapFactionsDisabled}
					onClick={() => LayerFilterMenuPrt.Actions.swapTeams(props.stores)}
					size="icon-sm"
				>
					<Icons.ArrowLeftRight />
				</Button>
				<span className="text-right">{tr.text(L_Msgs.teamName(2))}</span>
			</div>
			<Button
				data-empty={!anySet}
				variant="ghost"
				size="icon-sm"
				className={CLEAR_BUTTON}
				title={tr.text(F_Msgs.clearFilter(tr.text(F_Msgs.matchup())))}
				onClick={clearAll}
			>
				<Icons.Trash />
			</Button>
			{rows.map((row) => (
				<MatchupRow key={row.team1} row={row} stores={props.stores} />
			))}
		</div>
	)
}

type MatchupRowDef = (typeof MATCHUP_ROWS)[number]

function MatchupRow(props: { row: MatchupRowDef; stores: LayerFilterMenuPrt.PredicatedKeyProp }) {
	const { row } = props
	const team1 = useMenuItem(row.team1, props.stores)
	const team2 = useMenuItem(row.team2, props.stores)
	const hasValue = F.editableCompHasValue(team1.comp) || F.editableCompHasValue(team2.comp)
	const label = tr.text(row.label)
	return (
		<>
			<span className="text-xs text-text-2 truncate" title={label}>
				{label}
			</span>
			<MatchupOperator row={row} comp={team1.comp} highlight={hasValue} stores={props.stores} />
			<MatchupCell label={label} item={team1} field={row.team1} stores={props.stores} />
			<MatchupCell label={label} item={team2} field={row.team2} stores={props.stores} />
			<Button
				data-empty={!hasValue}
				variant="ghost"
				size="icon-sm"
				className={CLEAR_BUTTON}
				title={tr.text(F_Msgs.clearFilter(label))}
				onClick={() => {
					team1.clear()
					team2.clear()
				}}
			>
				<Icons.Trash />
			</Button>
		</>
	)
}

// both sides of a row share team 1's operator, since setTeamRowOperator keeps them in step
function MatchupOperator(props: {
	row: MatchupRowDef
	comp: F.EditableCompNode
	highlight: boolean
	stores: LayerFilterMenuPrt.PredicatedKeyProp
}) {
	const cfg = ConfigClient.useEffectiveColConfig()
	const anchor = props.comp.args[0] as F.EditableScalarArg | undefined
	const opOptions = F.compOpSelectOptions(anchor ? F.argValueDomain(anchor, cfg) : undefined)
	return (
		<ComboBox
			allowEmpty={false}
			className={cn(
				'w-9 justify-center gap-0.5 px-0! font-mono text-text-2 [&>span]:overflow-visible [&_svg]:ml-0 [&_svg]:size-3',
				props.highlight && 'text-pri-hi',
			)}
			title={tr.text(F_Msgs.operatorPicker())}
			value={F.compOpSelectionKey(props.comp)}
			options={opOptions.map((o) => ({
				value: o.key,
				label: tr.text(F_Msgs.compOpLabels[o.key]),
				description: tr.text(F_Msgs.compOpDescription(o)),
			}))}
			onSelect={(key) => {
				const option = opOptions.find((o) => o.key === key)
				if (option) LayerFilterMenuPrt.Actions.setTeamRowOperator(props.stores, [props.row.team1, props.row.team2], option)
			}}
		/>
	)
}

function MatchupCell(props: {
	field: string
	label: string
	item: ReturnType<typeof useMenuItem>
	stores: LayerFilterMenuPrt.PredicatedKeyProp
}) {
	const { ref, possibleValues, comp } = props.item
	return (
		<Comparison
			ref={ref}
			columnEditable={false}
			showColumn={false}
			showOperator={false}
			highlight={F.editableCompHasValue(comp)}
			node={comp}
			allowedEnumValues={possibleValues}
			onSetAllValuesAllowed={unlockAllValues(props.stores)}
			onSetAllValuesAllowedLabel={tr.text(F_Msgs.clearOtherFilters())}
			// the title and the accessible name come from the dimension itself; only the placeholder is
			// shortened, since the row is already labelled and the cell has no room for "any faction"
			valuesEmptyLabel={tr.text(F_Msgs.teamColumnPlaceholder(props.label))}
			setNode={(update) => LayerFilterMenuPrt.Actions.setComparison(props.stores, props.field, update)}
			lockOnSingleOption
		/>
	)
}
