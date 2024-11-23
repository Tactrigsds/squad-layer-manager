import { produce } from 'immer'
import { Minus } from 'lucide-react'
import React from 'react'
import { flushSync } from 'react-dom'

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
import TabsList from './ui/tabs-list.tsx'

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
	addQueueItems: (queueItems: M.LayerQueueItem[]) => void
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

	const [selectedLayers, setSelectedLayers] = React.useState<M.MiniLayer[]>([])
	type AdditionType = 'vote' | 'layers'
	const [additionType, _setAdditionType] = React.useState<AdditionType>('layers')
	function setAdditionType(newAdditionType: AdditionType) {
		if (newAdditionType === 'vote') {
			setSelectedLayers((prev) => {
				const seenIds = new Set<string>()
				return prev.filter((layer) => {
					if (seenIds.has(layer.id)) {
						return false
					}
					seenIds.add(layer.id)
					return true
				})
			})
		}
		_setAdditionType(newAdditionType)
	}
	const selectedLayersBoxRef = React.useRef<HTMLDivElement>(null)
	function addLayer(layer: M.MiniLayer) {
		flushSync(() => {
			setSelectedLayers((layers) => {
				const updated = [...layers, layer]
				return updated
			})
		})
		selectedLayersBoxRef.current?.scrollTo({ top: selectedLayersBoxRef.current.scrollHeight })
	}
	function toggleLayer(layer: M.MiniLayer) {
		flushSync(() => {
			setSelectedLayers((layers) => {
				const hasLayer = layers.includes(layer)
				return hasLayer ? layers.filter((l) => l !== layer) : [...layers, layer]
			})
		})
		selectedLayersBoxRef.current?.scrollTo({ top: selectedLayersBoxRef.current.scrollHeight })
	}

	function removeLayer(index: number) {
		setSelectedLayers((layers) => layers.filter((l, idx) => idx !== index))
	}

	function reset() {
		props.onOpenChange(false)
		setSelectedLayers([])
		setFilter(DEFAULT_ADD_LAYER_FILTERS)
		lastDataRef.current = undefined
	}

	const canSubmit = selectedLayers.length > 0
	function submit() {
		if (!canSubmit) return
		if (additionType === 'layers') {
			const items: M.LayerQueueItem[] = selectedLayers.map((l) => ({ layerId: l.id, generated: false }))
			props.addQueueItems(items)
		} else if (additionType === 'vote') {
			const item: M.LayerQueueItem = {
				vote: { choices: selectedLayers.map((selected) => selected.id), defaultChoice: selectedLayers[0].id },
				generated: false,
			}
			props.addQueueItems([item])
		}
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
			<PopoverContent side="bottom" className="flex h-[400px] w-max flex-col">
				<div className="flex items-center justify-between">
					<h3 className={Typography.H3}>Add {additionType === 'vote' ? 'Vote' : 'Layers'} to Queue</h3>
					<div className="flex items-center space-x-2">
						<p className={Typography.P}>{selectedLayers.length} layers selected</p>
						<TabsList
							options={[
								{ label: 'Vote', value: 'vote' },
								{ label: 'Layers', value: 'layers' },
							]}
							active={additionType}
							setActive={setAdditionType}
						/>
						<Button disabled={!canSubmit} onClick={() => submit()}>
							Submit
						</Button>
					</div>
				</div>
				<div ref={contentRef} className="flex min-h-0 items-center space-x-2">
					{/* ------ filter config ------ */}
					<div className="grid h-full grid-cols-[auto_min-content_auto] gap-2">
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
							const autocompleteFilter = appliedFilters.length === 0 ? undefined : FB.and(appliedFilters)
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
					<div className="flex h-full min-w-[300px] space-x-2">
						<div className="flex h-full flex-col">
							<h4 className={Typography.H4}>Results</h4>
							<ScrollArea className="h-full max-h-[500px] min-h-0 space-y-2 text-xs">
								{!res.isFetchedAfterMount && selectedLayers.length === 0 && (
									<div className="p-2 text-sm text-gray-500">Set filter to see results</div>
								)}
								{res.isFetchedAfterMount && layersToDisplay?.length === 0 && (
									<div className="p-2 text-sm text-gray-500">No results found</div>
								)}
								{layersToDisplay &&
									layersToDisplay?.length > 0 &&
									layersToDisplay.map((layer, index) => {
										const layerSelected = selectedLayers.includes(layer)
										return (
											<React.Fragment key={layer.id + index.toString()}>
												{index > 0 && <Separator />}
												<button
													className={cn('w-full p-2 text-left data-[selected=true]:bg-accent', Typography.Small)}
													data-selected={additionType === 'vote' && layerSelected}
													onClick={() => (additionType === 'layers' ? addLayer(layer) : toggleLayer(layer))}
												>
													{Helpers.toShortLayerName(layer)}
												</button>
											</React.Fragment>
										)
									})}
							</ScrollArea>
						</div>
						<div className="flex h-full flex-col">
							<h4 className={Typography.H4}>Selected</h4>
							<ScrollArea ref={selectedLayersBoxRef} className="h-full max-h-[500px] min-h-0 space-y-2 text-xs">
								{selectedLayers.length === 0 && <div className="p-2 text-sm text-gray-500">No Layers Selected</div>}
								{selectedLayers.length > 0 &&
									selectedLayers.map((layer, index) => {
										return (
											<React.Fragment key={layer.id + index.toString()}>
												{index > 0 && <Separator />}
												<div className={cn('flex w-full place-items-center justify-between rounded p-2', Typography.Small)}>
													{Helpers.toShortLayerName(layer)}
													<Button size="icon" variant="ghost" className="h-5 w-5" onClick={() => removeLayer(index)}>
														<Minus color="hsl(var(--destructive))" />
													</Button>
												</div>
											</React.Fragment>
										)
									})}
							</ScrollArea>
						</div>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	)
}
