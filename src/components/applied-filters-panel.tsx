import { Button } from '@/components/ui/button'
import * as AppliedFiltersPrt from '@/frame-partials/applied-filters.partial.ts'
import type * as SquadServerFrame from '@/frames/squad-server.frame.ts'
import * as Gen from '@/lib/generator.ts'
import * as ZusUtils from '@/lib/zustand.ts'
import type * as F from '@/models/filter.models.ts'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Rx from 'rxjs'
import ComboBoxMulti from './combo-box/combo-box-multi.tsx'
import EmojiDisplay from './emoji-display.tsx'
import { FilterEntityLabel } from './filter-entity-select.tsx'
import { ScrollArea, ScrollBar } from './ui/scroll-area.tsx'
import { TriStateCheckbox } from './ui/tri-state-checkbox.tsx'

export default function AppliedFiltersPanel(
	props: { stores: Partial<SquadServerFrame.KeyProp> & AppliedFiltersPrt.KeyProp },
) {
	const filterEntities = FilterEntityClient.useFilterEntities()
	const scrollRef = React.useRef<HTMLDivElement>(null)
	const extraFilters = ZusUtils.useStore(AppliedFiltersPrt.ExtraFiltersStore, s => s.extraFilters)
	const [canScrollLeft, setCanScrollLeft] = React.useState(false)
	const [canScrollRight, setCanScrollRight] = React.useState(false)
	const canScroll = canScrollLeft || canScrollRight

	const scrollLeft = () => {
		if (scrollRef.current) {
			const viewport = scrollRef.current.querySelector('[data-radix-scroll-area-viewport]')
			viewport?.scrollBy({ left: -200, behavior: 'smooth' })
		}
	}

	const scrollRight = () => {
		if (scrollRef.current) {
			const viewport = scrollRef.current.querySelector('[data-radix-scroll-area-viewport]')
			viewport?.scrollBy({ left: 200, behavior: 'smooth' })
		}
	}

	const scrollToStart = () => {
		if (scrollRef.current) {
			const viewport = scrollRef.current.querySelector('[data-radix-scroll-area-viewport]')
			viewport?.scrollTo({ left: 0, behavior: 'smooth' })
		}
	}

	const scrollToEnd = () => {
		if (scrollRef.current) {
			const viewport = scrollRef.current.querySelector('[data-radix-scroll-area-viewport]')
			if (viewport) {
				viewport.scrollTo({ left: viewport.scrollWidth, behavior: 'smooth' })
			}
		}
	}

	React.useEffect(() => {
		const checkScrollability = () => {
			if (scrollRef.current) {
				const viewport = scrollRef.current.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement | null
				if (viewport) {
					const { scrollLeft, scrollWidth, clientWidth } = viewport
					setCanScrollLeft(scrollLeft > 0)
					setCanScrollRight(scrollLeft < scrollWidth - clientWidth - 1)
				}
			}
		}
		const viewport = scrollRef.current?.querySelector('[data-radix-scroll-area-viewport]')
		if (viewport) {
			checkScrollability()
			const visible$ = Rx.fromEvent(document, 'visibilitychange').pipe(Rx.filter(() => !document.hidden))

			const sub = Rx.merge(
				visible$,
				Rx.fromEvent(viewport, 'scroll'),
				Rx.fromEvent(window, 'resize'),
			).subscribe(checkScrollability)

			// Use ResizeObserver to detect content size changes
			const resizeObserver = new ResizeObserver(checkScrollability)
			resizeObserver.observe(viewport)

			return () => {
				sub.unsubscribe()
				resizeObserver.disconnect()
			}
		}
	}, [extraFilters])

	const poolFilterId: F.FilterEntityId | null = ZusUtils.useStore(
		props.stores.squadServer ?? null,
		s => s ? s.settings.saved.queue.mainPool.poolFilter?.filterId ?? null : null,
	)
	const selectableFilterIds: F.FilterEntityId[] = ZusUtils.useStore(
		props.stores.squadServer ?? null,
		ZusUtils.useShallow(s => s ? s.settings.saved.queue.mainPool.defaultSelectable.map(c => c.filterId) : []),
	)
	const extraFilterIds: F.FilterEntityId[] = Array.from(extraFilters).filter(id => !selectableFilterIds.includes(id))

	const options = Array.from(Gen.map(filterEntities.values(), function*(filter) {
		if (selectableFilterIds.includes(filter.id) || filter.id === poolFilterId) return
		yield {
			value: filter.id,
			label: <FilterEntityLabel filter={filter} />,
		}
	}))

	return (
		<div className="flex items-center gap-1">
			<Button
				variant="ghost"
				size="icon"
				className="h-8 w-6 shrink-0 data-[canscroll=false]:hidden"
				data-canscroll={canScroll}
				onClick={scrollLeft}
				onDoubleClick={scrollToStart}
				disabled={!canScrollLeft}
				title="Scroll left (double-click to go to start)"
			>
				<Icons.ChevronLeft className="h-4 w-4" />
			</Button>
			<ScrollArea ref={scrollRef} className="max-w-[55vw]">
				<div className="flex flex-row gap-2 w-max">
					{extraFilterIds.map((filterId) => {
						return <FilterCheckbox key={filterId} filterId={filterId} stores={{ appliedFilters: props.stores.appliedFilters }} />
					})}
				</div>
				<ScrollBar orientation="horizontal" />
			</ScrollArea>
			<Button
				variant="ghost"
				size="icon"
				className="h-8 w-6 shrink-0 data-[canscroll=false]:hidden"
				data-canscroll={canScroll}
				onClick={scrollRight}
				onDoubleClick={scrollToEnd}
				disabled={!canScrollRight}
				title="Scroll right (double-click to go to end)"
			>
				<Icons.ChevronRight className="h-4 w-4" />
			</Button>
			<ComboBoxMulti
				options={options}
				values={extraFilterIds}
				onSelect={(update) => AppliedFiltersPrt.Actions.selectExtraFilters(props.stores, update)}
			>
				<Button title="Edit extra filters" variant="ghost" size={extraFilterIds.length > 0 ? 'icon' : 'default'}>
					{extraFilterIds.length === 0 && (
						<div className="text-sm text-muted-foreground px-2">
							Add Extra Filters
						</div>
					)}
					<Icons.Edit />
				</Button>
			</ComboBoxMulti>
			<div className="flex flex-row gap-2 w-max">
				<PoolFilterCheckbox stores={props.stores} />
				{selectableFilterIds.map((filterId) => {
					return <FilterCheckbox key={filterId} filterId={filterId} stores={{ appliedFilters: props.stores.appliedFilters }} />
				})}
			</div>
			<div className="flex flex-row gap-2 w-max">
				<Button
					title="Disable all filters"
					variant="ghost"
					size="icon"
					onClick={() => {
						AppliedFiltersPrt.Actions.disableAllAppliedFilters(props.stores)
					}}
				>
					<Icons.Trash2 className="h-4 w-4" />
				</Button>
			</div>
		</div>
	)
}

const POOL_STATE_TITLES: Record<AppliedFiltersPrt.ApplyAs, string> = {
	regular: 'Only pool layers are shown (Ctrl+Click to show only layers outside the pool)',
	inverted: 'Only layers outside the pool are shown; they cannot be selected without the queue:force-write permission',
	disabled: 'The pool does not constrain the query: all layers are shown (Ctrl+Click to invert)',
}

// the pool filter is pinned; out-of-pool layers surfaced by the inverted/disabled states stay unselectable for
// users without queue:force-write, so no state needs to be locked away
function PoolFilterCheckbox({ stores }: { stores: Partial<SquadServerFrame.KeyProp> & AppliedFiltersPrt.KeyProp }) {
	const poolFilter = ZusUtils.useStore(
		stores.squadServer ?? null,
		ZusUtils.useShallow(s => s ? s.settings.saved.queue.mainPool.poolFilter : null),
	)
	const poolApplyAs = ZusUtils.useStore(stores.appliedFilters, s => s.appliedFilters.poolApplyAs)
	const filter = FilterEntityClient.useFilterEntities().get(poolFilter?.filterId as string)
	if (!poolFilter || !filter) return

	const emoji = poolApplyAs === 'inverted' ? filter.invertedEmoji ?? filter.emoji : filter.emoji
	return (
		<TriStateCheckbox
			variant="outline"
			checked={poolApplyAs}
			onCheckedChange={(applyAs) => AppliedFiltersPrt.Actions.setPoolApplyAs(stores, applyAs)}
			title={POOL_STATE_TITLES[poolApplyAs]}
		>
			{emoji && <EmojiDisplay size="sm" emoji={emoji} />}
			<span>{filter.name}</span>
		</TriStateCheckbox>
	)
}

function FilterCheckbox({ filterId, stores }: { filterId: string; stores: AppliedFiltersPrt.KeyProp }) {
	const storeAppliedState = ZusUtils.useStore(
		stores.appliedFilters,
		s => s.appliedFilters.filterStates.get(filterId) ?? 'disabled',
	)
	const filter = FilterEntityClient.useFilterEntities().get(filterId)

	if (!filter) return
	let emoji = filter?.emoji
	if (storeAppliedState === 'inverted' && filter.invertedEmoji) {
		emoji = filter.invertedEmoji
	}

	return (
		<TriStateCheckbox
			checked={storeAppliedState}
			onCheckedChange={(applyAs) => AppliedFiltersPrt.Actions.setAppliedFilterState(stores, filterId, applyAs)}
		>
			{emoji && <EmojiDisplay size="sm" emoji={emoji} />}
			<span>{filter?.name}</span>
		</TriStateCheckbox>
	)
}
