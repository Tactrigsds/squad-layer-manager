import { produce } from 'immer'
import React from 'react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { sleepUntil } from '@/lib/async'
import * as Helpers from '@/lib/display-helpers'
import * as EFB from '@/lib/editable-filter-builders'
import * as FB from '@/lib/filter-builders'
import { trpcReact } from '@/lib/trpc.client'
import * as Typography from '@/lib/typography.ts'
import { cn } from '@/lib/utils'
import * as M from '@/models'

import { Comparison } from './filter-card'

const DEFAULT_ADD_LAYER_FILTERS = EFB.and([
	EFB.comp(EFB.eq('Layer')),
	EFB.comp(EFB.eq('Faction_1')),
	EFB.comp(EFB.eq('SubFac_1')),
	EFB.comp(EFB.eq('Faction_2')),
	EFB.comp(EFB.eq('SubFac_2')),
	EFB.comp(EFB.eq('id')),
]) satisfies Extract<M.EditableFilterNode, { type: 'and' }>
export default function AddLayerPopover(props: {
	children: React.ReactNode
	addLayers: (ids: M.MiniLayer[]) => void
	open: boolean
	onOpenChange: (isOpen: boolean) => void
}) {
	const [filter, setFilter] = React.useState(DEFAULT_ADD_LAYER_FILTERS)

	const filterStates = filter.children.map((f) => f.type === 'comp' && M.isValidComparison(f.comp))
	const validFilter = filterStates.includes(true)
		? FB.and(filter.children.filter((f) => f.type === 'comp' && M.isValidComparison(f.comp)) as M.FilterNode[])
		: undefined
	const shouldQuery = filterStates.includes(true)
	const seedRef = React.useRef(Math.ceil(Math.random() * Number.MAX_SAFE_INTEGER))
	//
	const res = trpcReact.getLayers.useQuery(
		{
			filter: validFilter,
			groupBy: ['id', 'Level', 'Gamemode', 'LayerVersion', 'Faction_1', 'SubFac_1', 'Faction_2', 'SubFac_2'],
			pageSize: 25,
			sort: {
				type: 'random',
				seed: seedRef.current,
			},
		},
		{
			enabled: shouldQuery,
			// TODO I would like to do state upstates which hook into query results before rerender, to do state updates like resetting filters if their current value is not part of the filter.
			// behavior: {
			// 	onFetch: (context, query) => {
			// 		console.log('onFetch', { context, query })
			// 	},
			// },
		}
	)
	const lastDataRef = React.useRef(res.data)
	React.useLayoutEffect(() => {
		if (res.data) {
			lastDataRef.current = res.data
		}
	}, [res.data, res.isError])

	const data = res.data ?? lastDataRef.current

	const layersToDisplay = data?.layers

	const [height, setHeight] = React.useState<number | null>(null)
	const contentRef = React.useRef<HTMLDivElement>(null)

	const [layersToAdd, setLayersToAdd] = React.useState<M.MiniLayer[]>([])
	function toggleLayerAdded(layerToAdd: M.MiniLayer) {
		setLayersToAdd((prevLayers) => {
			if (prevLayers.some((l) => l.id === layerToAdd.id)) {
				return prevLayers.filter((layer) => layer.id !== layerToAdd.id)
			} else {
				return [...prevLayers, layerToAdd]
			}
		})
	}

	function reset() {
		props.onOpenChange(false)
		setLayersToAdd([])
		setFilter(DEFAULT_ADD_LAYER_FILTERS)
		lastDataRef.current = undefined
	}

	function addAndClose() {
		props.addLayers(layersToAdd)
		reset()
	}

	function onOpenChange(open: boolean) {
		if (open) props.onOpenChange(true)
		else reset()
	}

	React.useEffect(() => {
		if (!props.open) return
		;(async () => {
			const content = await sleepUntil(() => contentRef.current)
			if (content) {
				setHeight(content.getBoundingClientRect().height + 25)
			}
		})()
	}, [props.open])

	function swapFactions() {
		setFilter(
			produce((draft) => {
				let faction1Index!: number
				let faction2Index!: number
				let subFac1Index!: number
				let subFac2Index!: number

				for (let i = 0; i < draft.children.length; i++) {
					const node = draft.children[i]
					if (node.type !== 'comp') throw new Error('there should only be comparison types when adding layers')
					if (node.comp.column === 'Faction_1') {
						faction1Index = i
					}
					if (node.comp.column === 'Faction_2') {
						faction2Index = i
					}
					if (node.comp.column === 'SubFac_1') {
						subFac1Index = i
					}
					if (node.comp.column === 'SubFac_2') {
						subFac2Index = i
					}
				}

				const faction1 = { ...draft.children[faction1Index].comp }
				const subFac1 = { ...draft.children[subFac1Index].comp }

				draft.children[faction1Index].comp = { ...draft.children[faction2Index].comp, column: 'Faction_1' }
				draft.children[subFac1Index].comp = { ...draft.children[subFac2Index].comp, column: 'SubFac_1' }
				draft.children[faction2Index].comp = { ...faction1, column: 'Faction_2' }
				draft.children[subFac2Index].comp = { ...subFac1, column: 'SubFac_2' }
			})
		)
	}

	return (
		<Popover open={props.open} modal={true} onOpenChange={onOpenChange}>
			<PopoverTrigger asChild>{props.children}</PopoverTrigger>
			<PopoverContent side="bottom" className="w-max">
				<div className="flex items-center justify-between">
					<h3 className={Typography.H3}>Add Layers to Queue</h3>
					<div className="flex items-center space-x-1">
						<p className={Typography.P}>{layersToAdd.length} layers selected</p>
						<Button disabled={layersToAdd.length === 0 || !props.open} variant="secondary" onClick={() => setLayersToAdd([])}>
							Clear
						</Button>
						<Button disabled={layersToAdd.length === 0 || !props.open} onClick={addAndClose}>
							Add Selected
						</Button>
					</div>
				</div>
				<div ref={contentRef} style={height ? { height } : {}} className="flex items-center space-x-2 min-h-0">
					{/* ------ filter config ------ */}
					<div className="grid grid-cols-[auto_min-content_auto] gap-2">
						{filter.children.map((_node, index) => {
							const setComp = (updateCallback: (prevComp: M.EditableComparison) => M.EditableComparison) => {
								setFilter(
									produce((draft) => {
										const node = draft.children[index] as Extract<M.EditableFilterNode, { type: 'comp' }>
										node.comp = updateCallback(node.comp)
									})
								)
							}
							const appliedFilters: M.FilterNode[] | undefined = []
							for (let i = 0; i < index; i++) {
								if (!filterStates[i]) continue
								appliedFilters.push(filter.children[i] as M.FilterNode)
							}
							const autocompleteFilter = appliedFilters.length === 0 ? undefined : FB.and(...appliedFilters)
							const node = _node as Extract<M.EditableFilterNode, { type: 'comp' }>
							return (
								<React.Fragment key={index}>
									{node.comp.column === 'Faction_2' && (
										<>
											<span />
											<Button onClick={swapFactions} variant="outline">
												Swap Factions
											</Button>
											<span />
										</>
									)}
									{(node.comp.column === 'id' || node.comp.column === 'Faction_1') && (
										<>
											<Separator className="col-span-3" />
										</>
									)}
									<Comparison columnEditable={false} comp={node.comp} setComp={setComp} valueAutocompleteFilter={autocompleteFilter} />
								</React.Fragment>
							)
						})}
					</div>
					{/* ------ filter results ------ */}
					<div className="min-w-[300px] h-full">
						{layersToDisplay && (
							<ScrollArea className={`h-full min-h-0 max-h-[500px]`}>
								<div className="h-full min-h-0 text-xs">
									{!res.isFetchedAfterMount && layersToDisplay.length === 0 && (
										<div className="p-2 text-sm text-gray-500">Set filter to see results</div>
									)}
									{res.isFetchedAfterMount && layersToDisplay.length === 0 && (
										<div className="p-2 text-sm text-gray-500">No results found</div>
									)}
									{layersToDisplay.length > 0 &&
										layersToDisplay.map((layer, index) => {
											const layerAdded = layersToAdd.includes(layer)
											return (
												<React.Fragment key={layer.id}>
													{index > 0 && <Separator />}
													<button
														className={cn('w-full py-2 text-left', Typography.Small, layerAdded && 'bg-accent')}
														onClick={() => toggleLayerAdded(layer)}
													>
														{Helpers.toShortLayerName(layer)}
													</button>
												</React.Fragment>
											)
										})}
								</div>
							</ScrollArea>
						)}
					</div>
				</div>
			</PopoverContent>
		</Popover>
	)
}
