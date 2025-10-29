import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { selectProps } from '@/lib/object.ts'
import { useRefConstructor } from '@/lib/react'
import * as ZusUtils from '@/lib/zustand.ts'
import * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as LFM from '@/models/layer-filter-menu.models'
import * as LQY from '@/models/layer-queries.models'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'
import { Comparison, ComparisonHandle } from './filter-card'

export default function LayerFilterMenu(
	props: { filterMenuStore: Zus.StoreApi<LFM.FilterMenuStore> },
) {
	const storeState = ZusUtils.useStoreDeep(
		props.filterMenuStore,
		state => selectProps(state, ['menuItems', 'siblingFilters']),
		{ dependencies: [] },
	)
	const clearAll$Ref = useRefConstructor(() => new Rx.Subject<void>())

	return (
		<div className="flex flex-col space-y-2">
			<div className="grid h-full grid-cols-[auto_min-content_auto_auto] gap-2">
				{Object.entries(storeState.menuItems).map(([field, comparison]) => (
					<LayerFilterMenuItem
						key={field}
						field={field}
						comp={comparison}
						store={props.filterMenuStore}
						clearAll$={clearAll$Ref.current}
					/>
				))}
			</div>
			<div>
				<Button
					variant="secondary"
					onClick={() => {
						props.filterMenuStore.getState().resetAllFilters()
						clearAll$Ref.current.next()
					}}
				>
					Clear All
				</Button>
			</div>
		</div>
	)
}

function LayerFilterMenuItem(
	props: {
		field: string
		comp: F.EditableComparison
		store: Zus.StoreApi<LFM.FilterMenuStore>
		clearAll$: Rx.Subject<void>
	},
) {
	const ref = React.useRef<ComparisonHandle>(null)
	const [swapFactionsDisabled, queryBaseInput] = ZusUtils.useStoreDeep(
		props.store,
		state => [LFM.selectSwapFactionsDisabled(state), LFM.selectFilterMenuItemConstraints(state, props.field)] as const,
		{ dependencies: [props.field] },
	)

	React.useEffect(() => {
		const sub = props.clearAll$.subscribe(() => {
			ref.current?.clear(true)
		})
		return () => sub.unsubscribe()
	}, [props.clearAll$])

	return (
		<React.Fragment key={props.field}>
			{(props.field === 'Map' || props.field === 'Alliance_1') && <Separator className="col-span-4 my-2" />}
			{props.field === 'Alliance_2' && (
				<div className="col-span-4 space-x-1 flex flex-row items-center">
					<Button
						title="Swap Factions"
						disabled={swapFactionsDisabled}
						onClick={() => {
							return props.store.getState().swapTeams()
						}}
						size="icon"
						variant="outline"
					>
						<Icons.FlipVertical2 />
					</Button>
					<Separator />
				</div>
			)}
			<Comparison
				ref={ref}
				columnEditable={false}
				highlight={F.editableComparisonHasValue(props.comp)}
				comp={props.comp}
				setComp={(update) => {
					return props.store.getState().setComparison(props.field, update)
				}}
				baseQueryInput={queryBaseInput}
				lockOnSingleOption={true}
			/>
			<Button
				disabled={!F.editableComparisonHasValue(props.comp)}
				variant="ghost"
				size="icon"
				onClick={() => {
					const colDef = LC.getColumnDef(props.field)
					if (!colDef) {
						console.warn('Column definition not found for field:', props.field)
						return
					}

					props.store.getState().resetFilter(props.field)
					ref.current?.clear(true)
				}}
			>
				<Icons.Trash />
			</Button>
			{props.field === 'Unit_2' && <Separator className="col-span-4 my-2" />}
		</React.Fragment>
	)
}
