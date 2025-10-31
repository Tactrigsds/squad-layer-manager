import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import * as LayerFilterMenuCtx from '@/frame-contexts/layer-filter-menu'
import * as SelectLayersFrame from '@/frames/select-layers.frame'
import { useRefConstructor } from '@/lib/react'
import * as ZusUtils from '@/lib/zustand.ts'
import * as F from '@/models/filter.models'
import * as LC from '@/models/layer-columns'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Rx from 'rxjs'
import { Comparison, ComparisonHandle } from './filter-card'

export default function LayerFilterMenu(props: { frameKey: SelectLayersFrame.Key }) {
	const clearAll$Ref = useRefConstructor(() => new Rx.Subject<void>())
	const fields = SelectLayersFrame.useSelectedSelectLayersState(
		props.frameKey,
		ZusUtils.useShallow((s) => Object.keys(s.filterMenu.menuItems)),
	)
	const state = SelectLayersFrame.useSelectLayersState(props.frameKey)

	return (
		<div className="flex flex-col space-y-2">
			<div className="grid h-full grid-cols-[auto_min-content_auto_auto] gap-2">
				{fields.map((field) => (
					<LayerFilterMenuItem
						key={field}
						field={field}
						clearAll$={clearAll$Ref.current}
						frameKey={props.frameKey}
					/>
				))}
			</div>
			<div>
				<Button
					variant="secondary"
					onClick={() => {
						state.filterMenu.resetAllFilters()
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
		clearAll$: Rx.Subject<void>
		frameKey: SelectLayersFrame.Key
	},
) {
	const ref = React.useRef<ComparisonHandle>(null)
	const [swapFactionsDisabled, queryInput, comp] = SelectLayersFrame.useSelectedSelectLayersState(
		props.frameKey,
		ZusUtils.useDeep(
			state =>
				[
					LayerFilterMenuCtx.selectSwapFactionsDisabled(state),
					SelectLayersFrame.selectMenuItemQueryInput(state, props.field),
					state.filterMenu.menuItems[props.field],
				] as const,
		),
	)
	const state = SelectLayersFrame.useSelectLayersState(props.frameKey)

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
							return state.filterMenu.swapTeams()
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
				highlight={F.editableComparisonHasValue(comp)}
				comp={comp}
				setComp={(update) => {
					return state.filterMenu.setComparison(props.field, update)
				}}
				baseQueryInput={queryInput}
				lockOnSingleOption={true}
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

					state.filterMenu.resetFilter(props.field)
					ref.current?.clear(true)
				}}
			>
				<Icons.Trash />
			</Button>
			{props.field === 'Unit_2' && <Separator className="col-span-4 my-2" />}
		</React.Fragment>
	)
}
