import * as Icons from 'lucide-react'
import React from 'react'

import { Button } from '@/components/ui/button'
import * as LayerFilterMenuPrt from '@/frame-partials/layer-filter-menu.partial'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand.ts'
import * as F_Msgs from '@/messages/filter.messages'
import * as L_Msgs from '@/messages/layer.messages'
import * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as VEH from '@/models/vehicles.models'
import { tr } from '@/systems/messages.client'

import type { ComparisonHandle } from './filter-card'
import { Comparison } from './filter-card'

const MATCHUP_ROWS = F.TEAM_COLUMNS.map((column) => ({
	label: F.TEAM_COLUMN_LABELS[column],
	team1: F.resolveTeamColumn(column, 1),
	team2: F.resolveTeamColumn(column, 2),
}))
const TEAM_FIELDS = MATCHUP_ROWS.flatMap((row) => [row.team1, row.team2])

/**
 * The constraint rail: one row per field with a symbol-width operator and a value select, and the team
 * fields folded into one matchup node (a select per side per dimension, swap between the sides).
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
	const label = colDef?.shortName ?? colDef?.displayName ?? props.field

	return (
		<div className="grid grid-cols-[72px_36px_minmax(0,1fr)_20px] items-center gap-1 [&_button[role=combobox]]:w-full [&_button[role=combobox]]:min-w-0">
			<span className="text-xs text-text-2 whitespace-nowrap truncate" title={colDef?.displayName}>
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
		<div className="grid grid-cols-[72px_minmax(0,1fr)_minmax(0,1fr)_20px] items-center gap-1 [&_button[role=combobox]]:w-full [&_button[role=combobox]]:min-w-0">
			<span className="text-xs text-text-2 whitespace-nowrap">{tr.text(F_Msgs.matchup())}</span>
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
				<React.Fragment key={row.label}>
					<span className="text-xs text-text-2 truncate" title={row.label}>
						{row.label}
					</span>
					<MatchupCell field={row.team1} label={row.label} stores={props.stores} />
					<MatchupCell field={row.team2} label={row.label} stores={props.stores} />
					<span />
				</React.Fragment>
			))}
		</div>
	)
}

function MatchupCell(props: { field: string; label: string; stores: LayerFilterMenuPrt.PredicatedKeyProp }) {
	const { ref, possibleValues, comp } = useMenuItem(props.field, props.stores)
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
