import { produce } from 'immer'
import { Minus } from 'lucide-react'
import React from 'react'
import { flushSync } from 'react-dom'
import stringifyCompact from 'json-stringify-pretty-compact'

import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { sleepUntil } from '@/lib/async'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import * as Helpers from '@/lib/display-helpers'
import * as EFB from '@/lib/editable-filter-builders'
import * as FB from '@/lib/filter-builders'
import { trpcReact } from '@/lib/trpc.client'
import * as Typography from '@/lib/typography.ts'
import { cn } from '@/lib/utils'
import * as M from '@/models'

import { Comparison } from './filter-card'
import TabsList from './ui/tabs-list.tsx'
import { assertNever } from '@/lib/typeGuards.ts'
import { Checkbox } from './ui/checkbox.tsx'

type SelectMode = 'vote' | 'layers'
export function SelectLayersPopover(props: {
	title: string
	pinMode?: SelectMode
	children: React.ReactNode
	selectQueueItems: (queueItems: M.LayerQueueItem[]) => void
	defaultSelected?: M.MiniLayer[]
	selectingSingleLayerQueueItem?: boolean
	baseFilter?: M.FilterNode
	open: boolean
	onOpenChange: (isOpen: boolean) => void
}) {
	const defaultSelected: M.MiniLayer[] = props.defaultSelected ?? []

	const [filterItem, setFilterItem] = React.useState<Partial<M.MiniLayer>>({})
	const [applyBaseFilter, setApplyBaseFilter] = React.useState(false)
	const pickerFilter = React.useMemo(() => {
		const nodes: M.FilterNode[] = []

		for (const _key in filterItem) {
			const key = _key as keyof M.MiniLayer
			if (filterItem[key] === undefined) continue
			nodes.push(FB.comp(FB.eq(key, filterItem[key])))
		}
		if (nodes.length === 0) return undefined

		if (applyBaseFilter && props.baseFilter) {
			nodes.push(props.baseFilter)
		}
		return FB.and(nodes)
	}, [filterItem, applyBaseFilter, props.baseFilter])

	const [selectedLayers, setSelectedLayers] = React.useState<M.MiniLayer[]>(defaultSelected)
	const [selectMode, _setSelectMode] = React.useState<SelectMode>(props.pinMode ?? 'layers')
	function setAdditionType(newAdditionType: SelectMode) {
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
		_setSelectMode(newAdditionType)
	}

	const canSubmit = selectedLayers.length > 0
	function submit() {
		if (!canSubmit) return
		if (selectMode === 'layers') {
			const items: M.LayerQueueItem[] = selectedLayers.map((l) => ({ layerId: l.id, generated: false }))
			props.selectQueueItems(items)
		} else if (selectMode === 'vote') {
			const item: M.LayerQueueItem = {
				vote: { choices: selectedLayers.map((selected) => selected.id), defaultChoice: selectedLayers[0].id },
				generated: false,
			}
			props.selectQueueItems([item])
		}
		onOpenChange(false)
	}
	const applyBaseFilterId = React.useId()

	function onOpenChange(open: boolean) {
		console.log('onOpenChange', open)
		if (open) {
			setSelectedLayers(defaultSelected)
			setFilterItem({})
		}
		props.onOpenChange(open)
	}

	return (
		<Dialog open={props.open} onOpenChange={onOpenChange}>
			<DialogTrigger asChild>{props.children}</DialogTrigger>
			<DialogContent className="w-auto max-w-full min-w-0">
				<DialogHeader>
					<DialogTitle>{props.title}</DialogTitle>
					<DialogDescription>Select layers to add to the queue, or to vote on.</DialogDescription>
					<div className="flex items-center w-full space-x-2">
						<p className={Typography.P}>{selectedLayers.length} layers selected</p>
						<div className="items-top flex space-x-2">
							<Checkbox
								checked={applyBaseFilter}
								onCheckedChange={(v) => {
									if (v === 'indeterminate') return
									setApplyBaseFilter(v)
								}}
								id={applyBaseFilterId}
							/>
							<div className="grid gap-1.5 leading-none">
								<label
									htmlFor={applyBaseFilterId}
									className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
								>
									Apply base filter
								</label>
							</div>
						</div>
						{!props.pinMode && (
							<TabsList
								options={[
									{ label: 'Vote', value: 'vote' },
									{ label: 'Layers', value: 'layers' },
								]}
								active={selectMode}
								setActive={setAdditionType}
							/>
						)}
					</div>
				</DialogHeader>

				<div className="flex min-h-0 items-center space-x-2">
					<LayerSelect filterLayer={filterItem} setFilterLayer={setFilterItem} baseFilter={props.baseFilter} />
					<ListStyleLayerPicker
						filter={pickerFilter}
						selected={selectedLayers}
						setSelected={setSelectedLayers}
						pickerMode={selectMode === 'vote' ? 'toggle' : 'add'}
					/>
				</div>

				<DialogFooter>
					<Button disabled={!canSubmit} onClick={submit}>
						Submit
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

function ListStyleLayerPicker(props: {
	filter?: M.FilterNode
	selected: M.MiniLayer[]
	setSelected: React.Dispatch<React.SetStateAction<M.MiniLayer[]>>
	pickerMode: 'toggle' | 'add' | 'single'
}) {
	const seedRef = React.useRef(Math.ceil(Math.random() * Number.MAX_SAFE_INTEGER))
	const res = trpcReact.getLayers.useQuery(
		{
			filter: props.filter,
			groupBy: ['id', 'Level', 'Gamemode', 'LayerVersion', 'Faction_1', 'SubFac_1', 'Faction_2', 'SubFac_2'],
			pageSize: 25,
			sort: {
				type: 'random',
				seed: seedRef.current,
			},
		},
		{
			enabled: !!props.filter,
		}
	)

	// --------  selected layer mutations ---------
	const selectedLayersBoxRef = React.useRef<HTMLDivElement>(null)
	function addLayer(layer: M.MiniLayer) {
		flushSync(() => {
			props.setSelected((layers) => {
				const updated = [...layers, layer]
				return updated
			})
		})
		selectedLayersBoxRef.current?.scrollTo({ top: selectedLayersBoxRef.current.scrollHeight })
	}
	function toggleLayer(layer: M.MiniLayer) {
		flushSync(() => {
			props.setSelected((layers) => {
				const hasLayer = layers.includes(layer)
				return hasLayer ? layers.filter((l) => l !== layer) : [...layers, layer]
			})
		})
		selectedLayersBoxRef.current?.scrollTo({ top: selectedLayersBoxRef.current.scrollHeight })
	}
	const setSelected = props.setSelected
	const setLayer = React.useCallback(
		(layer: M.MiniLayer) => {
			setSelected([layer])
		},
		[setSelected]
	)

	const lastDataRef = React.useRef(res.data)
	React.useLayoutEffect(() => {
		if (res.data) {
			lastDataRef.current = res.data
		}
	}, [res.data, res.isError])
	React.useEffect(() => {
		if (props.pickerMode !== 'single' || res.data?.layers?.length !== 1) return
		const layer = res.data.layers[0]
		if (layer.id !== props.selected[0]?.id) setLayer(res.data.layers[0])
	}, [res.data, props.pickerMode, setLayer, props.selected])

	const data = res.data ?? lastDataRef.current

	const layersToDisplay = data?.layers
	if (props.pickerMode === 'single') {
		if (!layersToDisplay) return <div>Loading...</div>
		if (layersToDisplay?.length === 1) {
			return (
				<div className="rounded p-2">
					Selected <i>{Helpers.toShortLayerName(layersToDisplay[0])}</i>
				</div>
			)
		}
		if (layersToDisplay?.length === 0) {
			return <div className="rounded p-2">No Layers Found</div>
		}
		if (layersToDisplay && layersToDisplay.length > 1) {
			return (
				<div>
					<h4 className={Typography.H4}>Results</h4>
					<ScrollArea className="h-full max-h-[500px] min-h-0 space-y-2 text-xs">
						{layersToDisplay.map((layer, index) => {
							return (
								<React.Fragment key={layer.id + index.toString()}>
									{index > 0 && <Separator />}
									<button
										className={cn('w-full p-2 text-left data-[selected=true]:bg-accent', Typography.Small)}
										data-selected={props.selected[0]?.id === layer.id}
										onClick={() => setLayer(layer)}
									>
										{Helpers.toShortLayerName(layer)}
									</button>
								</React.Fragment>
							)
						})}
					</ScrollArea>
				</div>
			)
		}
		throw new Error('Unexpected number of layers to display')
	}
	return (
		<div className="flex h-full min-w-[300px] space-x-2">
			{/* ------ filter results ------ */}
			<div className="flex h-full space-x-2">
				<div className="flex-flex-col">
					<h4 className={Typography.H4}>Results</h4>
					<ScrollArea className="h-full max-h-[500px] w-max min-h-0 space-y-2 text-xs">
						{!res.isFetchedAfterMount && props.selected.length === 0 && (
							<div className="p-2 text-sm text-gray-500">Set filter to see results</div>
						)}
						{res.isFetchedAfterMount && layersToDisplay?.length === 0 && <div className="p-2 text-sm text-gray-500">No results found</div>}
						{layersToDisplay &&
							layersToDisplay?.length > 0 &&
							layersToDisplay.map((layer, index) => {
								const layerSelected = props.selected.includes(layer)
								return (
									<React.Fragment key={layer.id + index.toString()}>
										{index > 0 && <Separator />}
										<button
											className={cn('w-full p-2 text-left data-[selected=true]:bg-accent', Typography.Small)}
											data-selected={props.pickerMode === 'toggle' && layerSelected}
											onClick={() => {
												if (props.pickerMode === 'add') return addLayer(layer)
												if (props.pickerMode === 'toggle') return toggleLayer(layer)
												throw new Error('Unexpected picker mode ' + props.pickerMode)
											}}
										>
											{Helpers.toShortLayerName(layer)}
										</button>
									</React.Fragment>
								)
							})}
					</ScrollArea>
				</div>

				{/* ------ selected layers ------ */}
				<div className="flex flex-col">
					<h4 className={Typography.H4}>Selected</h4>
					<ScrollArea className="h-full max-h-[500px] w-max min-h-0 space-y-2 text-xs" ref={selectedLayersBoxRef}>
						{props.selected.map((layer, index) => {
							return (
								<React.Fragment key={layer.id + index.toString()}>
									{index > 0 && <Separator />}
									<button
										className={cn(
											'flex min-w-0 space-x-2 items-center w-full p-2 text-left data-[selected=true]:bg-accent',
											Typography.Small
										)}
										onClick={() => {
											setSelected((prev) => prev.filter((l) => l !== layer))
										}}
									>
										<span className="whitespace-nowrap grow">{Helpers.toShortLayerName(layer)}</span>
										<Minus color="hsl(var(--destructive))" />
									</button>
								</React.Fragment>
							)
						})}
					</ScrollArea>
				</div>
			</div>
		</div>
	)
}

function itemToLayers(item: M.LayerQueueItem): M.MiniLayer[] {
	let layers: M.MiniLayer[]
	if (item.vote) {
		layers = item.vote.choices.map((choice) => M.getMiniLayerFromId(choice))
	} else if (item.layerId) {
		layers = [M.getMiniLayerFromId(item.layerId)]
	} else {
		throw new Error('Invalid LayerQueueItem')
	}
	return layers
}

export function EditLayerQueueItemPopover(props: {
	open: boolean
	onOpenChange: React.Dispatch<React.SetStateAction<boolean>>
	children: React.ReactNode
	item: M.LayerQueueItem
	setItem: React.Dispatch<React.SetStateAction<M.LayerQueueItem>>
	baseFilter?: M.FilterNode
}) {
	const [editedItem, setEditedItem] = React.useState<M.LayerQueueItem>(props.item)
	const [filterLayer, setFilterLayer] = React.useState<Partial<M.MiniLayer>>(itemToMiniLayer(props.item))
	const [applyBaseFilter, setApplyBaseFilter] = React.useState(false)
	const applyBaseFilterId = React.useId()

	const pickerFilter = React.useMemo(() => {
		const nodes: M.FilterNode[] = []

		for (const _key in filterLayer) {
			const key = _key as keyof M.MiniLayer
			if (filterLayer[key] === undefined) continue
			nodes.push(FB.comp(FB.eq(key, filterLayer[key])))
		}
		if (nodes.length === 0) return undefined

		if (applyBaseFilter && props.baseFilter) {
			nodes.push(props.baseFilter)
		}
		return FB.and(nodes)
	}, [filterLayer, applyBaseFilter, props.baseFilter])

	const selectedLayers = itemToLayers(editedItem)
	const setSelectedLayers: React.Dispatch<React.SetStateAction<M.MiniLayer[]>> = (update) => {
		setEditedItem(
			produce((prev) => {
				const prevLayers = itemToLayers(prev)
				const newLayers = typeof update === 'function' ? update(prevLayers) : update
				if (prev.vote) {
					prev.vote.choices = newLayers.map((l) => l.id)
					prev.vote.defaultChoice = newLayers[0].id
				} else {
					prev.layerId = newLayers[0].id
				}
			})
		)
	}

	const canSubmit = selectedLayers.length > 0
	function submit(e: React.FormEvent) {
		e.preventDefault()
		if (!canSubmit) return
		props.setItem(editedItem)
		onOpenChange(false)
	}

	function onOpenChange(open: boolean) {
		if (open) {
			setEditedItem(props.item)
			setFilterLayer({})
		}
		props.onOpenChange(open)
	}

	return (
		<Dialog open={props.open} onOpenChange={onOpenChange}>
			<DialogTrigger asChild>{props.children}</DialogTrigger>
			<DialogContent className="w-auto max-w-full min-w-0">
				<DialogHeader>
					<DialogTitle>Edit</DialogTitle>
					<DialogDescription>Change the layer or vote choices for this queue item.</DialogDescription>
				</DialogHeader>

				<div className="flex space-x-2 items-center">
					<div className="items-top flex space-x-2">
						<Checkbox
							checked={applyBaseFilter}
							onCheckedChange={(v) => {
								if (v === 'indeterminate') return
								setApplyBaseFilter(v)
							}}
							id={applyBaseFilterId}
						/>
						<div className="grid gap-1.5 leading-none">
							<label
								htmlFor={applyBaseFilterId}
								className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
							>
								Apply base filter
							</label>
						</div>
					</div>
					<TabsList
						options={[
							{ label: 'Vote', value: 'vote' },
							{ label: 'Set Layer', value: 'layer' },
						]}
						active={editedItem.vote ? 'vote' : 'layer'}
						setActive={(itemType) => {
							setEditedItem((prev) => {
								const selectedLayers = itemToLayers(prev)
								if (itemType === 'vote') {
									return {
										vote: {
											choices: selectedLayers.map((l) => l.id),
											defaultChoice: selectedLayers[0].id,
										},
										generated: false,
									}
								} else if (itemType === 'layer') {
									return {
										layerId: selectedLayers[0].id,
										generated: false,
									}
								} else {
									assertNever(itemType)
								}
							})
						}}
					/>
				</div>

				<div className="flex space-x-2 min-h-0">
					<LayerSelect
						filterLayer={filterLayer}
						setFilterLayer={setFilterLayer}
						baseFilter={applyBaseFilter ? props.baseFilter : undefined}
					/>
					<ListStyleLayerPicker
						pickerMode={editedItem.vote ? 'toggle' : 'single'}
						selected={selectedLayers}
						setSelected={setSelectedLayers}
						filter={pickerFilter}
					/>
				</div>

				<DialogFooter>
					<Button disabled={!canSubmit} onClick={submit}>
						Submit
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

function itemToMiniLayer(item: M.LayerQueueItem): M.MiniLayer {
	if (item.vote) {
		return M.getMiniLayerFromId(item.vote.defaultChoice)
	}
	if (item.layerId) {
		return M.getMiniLayerFromId(item.layerId)
	}
	throw new Error('Invalid LayerQueueItem')
}

const FILTER_ORDER = [
	'id',
	'Layer',
	'Level',
	'Gamemode',
	'LayerVersion',
	'Faction_1',
	'SubFac_1',
	'Faction_2',
	'SubFac_2',
] as const satisfies (keyof M.MiniLayer)[]

function LayerSelect(props: {
	filterLayer: Partial<M.MiniLayer>
	setFilterLayer: React.Dispatch<React.SetStateAction<Partial<M.MiniLayer>>>
	baseFilter?: M.FilterNode
}) {
	const filterComparisons: [keyof M.MiniLayer, M.EditableComparison][] = []
	for (const key of FILTER_ORDER) {
		filterComparisons.push([key, EFB.eq(key, props.filterLayer[key])])
	}

	return (
		<div className="grid h-full grid-cols-[auto_min-content_auto] gap-2">
			{filterComparisons.map(([name, comparison], index) => {
				const setComp: React.Dispatch<React.SetStateAction<M.EditableComparison>> = (update) => {
					props.setFilterLayer(
						produce((prev) => {
							const comp = typeof update === 'function' ? update(EFB.eq(name, prev[name])) : update
							if (comp.column === 'id' && comp.value) {
								return M.getMiniLayerFromId(comp.value as string)
							} else if (comp.column === 'Layer' && comp.value) {
								const parsedLayer = M.parseLayerString(comp.value as string)
								prev.Level = parsedLayer.level
								prev.Gamemode = parsedLayer.gamemode
								prev.LayerVersion = parsedLayer.version
							} else if (comp.column === 'Layer' && !comp.value) {
								delete prev.Layer
								delete prev.Level
								delete prev.Gamemode
								delete prev.LayerVersion
							} else if (comp !== undefined) {
								// @ts-expect-error null can be valid here
								prev[name] = comp.value
							} else if (comp.value === undefined) {
								delete prev[name]
							}
							if (M.LAYER_STRING_PROPERTIES.every((p) => p in prev)) {
								prev.Layer = M.getLayerString(prev as M.MiniLayer)
							} else {
								delete prev.Layer
							}
							delete prev.id

							// do we have all of the fields required to build the id? commented out for now because we don't want to auto populate the id field in most scenarios
							// if (Object.keys(comp).length >= Object.keys(M.MiniLayerSchema.shape).length - 1) {
							// 	prev.id = M.getLayerId(prev as M.LayerIdArgs)
							// }
						})
					)
				}
				function swapFactions() {
					props.setFilterLayer(
						produce((prev) => {
							const faction1 = prev.Faction_1
							const subFac1 = prev.SubFac_1
							prev.Faction_1 = prev.Faction_2
							prev.SubFac_1 = prev.SubFac_2
							prev.Faction_2 = faction1
							prev.SubFac_2 = subFac1
						})
					)
				}

				const appliedFilters: M.FilterNode[] | undefined = []
				if (props.baseFilter) {
					appliedFilters.push(props.baseFilter)
				}
				// skip the first two filters (id and Layer) because of their very high specificity
				for (let i = 2; i < index; i++) {
					const comparison = filterComparisons[i][1]
					if (!M.isValidComparison(comparison)) continue
					appliedFilters.push(FB.comp(comparison))
				}
				const autocompleteFilter = appliedFilters.length > 0 ? FB.and(appliedFilters) : undefined

				return (
					<React.Fragment key={name}>
						{(name === 'Level' || name === 'Faction_1') && <Separator className="col-span-3 my-2" />}
						{name === 'Faction_2' && (
							<>
								<Button onClick={swapFactions} variant="outline">
									Swap Factions
								</Button>
								<span />
								<span />
							</>
						)}
						<Comparison columnEditable={false} comp={comparison} setComp={setComp} valueAutocompleteFilter={autocompleteFilter} />
					</React.Fragment>
				)
			})}
		</div>
	)
}
