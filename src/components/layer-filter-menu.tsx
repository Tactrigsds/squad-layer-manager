import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import * as LayerFilterMenuPrt from '@/frame-partials/layer-filter-menu.partial'
import * as ZusUtils from '@/lib/zustand.ts'
import * as F from '@/models/filter.models'
import * as LC from '@/models/layer-columns'
import * as Icons from 'lucide-react'
import React from 'react'
import type { ComparisonHandle } from './filter-card'
import { Comparison } from './filter-card'

export default function LayerFilterMenu(props: { stores: LayerFilterMenuPrt.PredicatedKeyProp }) {
	const fields = ZusUtils.useStore(
		props.stores.filterMenu,
		ZusUtils.useShallow((s) => Object.keys(s.filterMenu.menuItems)),
	)

	return (
		<div className="grid h-full grid-cols-[auto_min-content_auto_auto] gap-2">
			{fields.map((field) => (
				<LayerFilterMenuItem
					key={field}
					field={field}
					stores={props.stores}
				/>
			))}
			<Button
				className="col-span-full"
				variant="secondary"
				onClick={() => {
					LayerFilterMenuPrt.Actions.resetAllFilters(props.stores)
				}}
			>
				<Icons.Trash /> Clear All
			</Button>
		</div>
	)
}

function LayerFilterMenuItem(
	props: {
		field: string
		stores: LayerFilterMenuPrt.PredicatedKeyProp
	},
) {
	// resetAllConstraints is a Predicate set up by the owning frame (select-layers / gen-vote), not part of
	// LayerFilterMenuPrt's own Key type, but always present on the concrete frame state at runtime.
	const getPredicates = () => ZusUtils.getState(props.stores.filterMenu)
	const ref = React.useRef<ComparisonHandle>(null)
	const [swapFactionsDisabled, possibleValues, comp] = ZusUtils.useStore(
		props.stores.filterMenu,
		ZusUtils.useDeep(
			state =>
				[
					LayerFilterMenuPrt.Sel.swapFactionsDisabled(state),
					state.filterMenuItemPossibleValues?.[props.field],
					state.filterMenu.menuItems[props.field],
				] as const,
		),
	)

	React.useEffect(() => {
		const sub = ZusUtils.getState(props.stores.filterMenu).filterMenu.clearAll$.subscribe(() => {
			ref.current?.clear(true)
		})
		return () => sub.unsubscribe()
	}, [props.stores])
	let unlockAllValues = () => {
		getPredicates().resetAllConstraints()
	}

	return (
		<React.Fragment key={props.field}>
			{(props.field === 'Map' || props.field === 'Alliance_1') && <Separator className="col-span-full my-2" />}
			{props.field === 'Alliance_2' && (
				<div className="col-span-full gap-1 flex items-center">
					<Button
						title="Swap Factions"
						disabled={swapFactionsDisabled}
						onClick={() => {
							return LayerFilterMenuPrt.Actions.swapTeams(props.stores)
						}}
						size="icon"
						variant="outline"
					>
						<Icons.FlipVertical2 />
					</Button>
					<Separator className="flex-1 shrink-0" />
				</div>
			)}
			<Comparison
				ref={ref}
				columnEditable={false}
				highlight={F.editableComparisonHasValue(comp)}
				comp={comp}
				allowedEnumValues={possibleValues}
				onSetAllValuesAllowed={unlockAllValues}
				onSetAllValuesAllowedLabel="Remove all other filters and select this one"
				setComp={(update) => {
					return LayerFilterMenuPrt.Actions.setComparison(props.stores, props.field, update)
				}}
				lockOnSingleOption
			/>
			<Button
				disabled={!F.editableComparisonHasValue(comp)}
				variant="ghost"
				size="icon"
				onClick={() => {
					const colDef = LC.getColumnDef(props.field)
					if (!colDef) {
						console.warn('Column definition not found for field:', props.field)
						return
					}

					LayerFilterMenuPrt.Actions.resetFilter(props.stores, props.field)
					ref.current?.clear(true)
				}}
			>
				<Icons.Trash />
			</Button>
			{props.field === 'Unit_2' && <Separator className="col-span-full my-2" />}
		</React.Fragment>
	)
}
