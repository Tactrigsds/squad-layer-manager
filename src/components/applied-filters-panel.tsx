import { Button } from '@/components/ui/button'
import type * as AppliedFiltersPrt from '@/frame-partials/applied-filters.partial.ts'
import { getFrameState, useFrameStore } from '@/frames/frame-manager.ts'
import * as Gen from '@/lib/generator.ts'
import * as ZusUtils from '@/lib/zustand.ts'
import type * as F from '@/models/filter.models.ts'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import * as QD from '@/systems/queue-dashboard.client'
import * as ServerSettingsClient from '@/systems/server-settings.client'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import ComboBoxMulti from './combo-box/combo-box-multi.tsx'
import EmojiDisplay from './emoji-display.tsx'
import { FilterEntityLabel } from './filter-entity-select.tsx'
import { ScrollArea, ScrollBar } from './ui/scroll-area.tsx'

import { TriStateCheckbox } from './ui/tri-state-checkbox.tsx'

export default function AppliedFiltersPanel(props: { frameKey: AppliedFiltersPrt.Key }) {
	const filterEntities = FilterEntityClient.useFilterEntities()
	const scrollRef = React.useRef<HTMLDivElement>(null)
	const extraFilters = Zus.useStore(QD.ExtraFiltersStore, s => s.extraFilters)
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

	const poolFilterIds: F.FilterEntityId[] = Zus.useStore(
		ServerSettingsClient.Store,
		ZusUtils.useShallow(s => s.saved.queue.mainPool.filters.map(c => c.filterId)),
	)
	const extraFilterIds: F.FilterEntityId[] = Array.from(extraFilters).filter(id => !poolFilterIds.includes(id))

	const options = Array.from(Gen.map(filterEntities.values(), function*(filter) {
		if (poolFilterIds.includes(filter.id)) return
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
						return <FilterCheckbox key={filterId} filterId={filterId} frameKey={props.frameKey} />
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
			<ComboBoxMulti options={options} values={extraFilterIds} onSelect={(update) => QD.ExtraFiltersStore.getState().select(update)}>
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
				{poolFilterIds.map((filterId) => {
					return <FilterCheckbox key={filterId} filterId={filterId} frameKey={props.frameKey} />
				})}
			</div>
			<div className="flex flex-row gap-2 w-max">
				<Button
					title="Disable all filters"
					variant="ghost"
					size="icon"
					onClick={() => {
						getFrameState(props.frameKey).disableAllAppliedFilters()
					}}
				>
					<Icons.Trash2 className="h-4 w-4" />
				</Button>
			</div>
		</div>
	)
}

function FilterCheckbox({ filterId, frameKey }: { filterId: string; frameKey: AppliedFiltersPrt.Key }) {
	const [storeAppliedState, setAppliedFilterState] = useFrameStore(
		frameKey,
		useShallow(s => [s.appliedFilters.get(filterId) ?? 'disabled', s.setAppliedFilterState]),
	)
	const filter = FilterEntityClient.useFilterEntities().get(filterId)

	if (!filter) return
	let emoji = filter?.emoji
	if (storeAppliedState === 'inverted' && filter.invertedEmoji) {
		emoji = filter.invertedEmoji
	}

	return (
		<TriStateCheckbox checked={storeAppliedState} onCheckedChange={(applyAs) => setAppliedFilterState(filterId, applyAs)}>
			{emoji && <EmojiDisplay size="sm" emoji={emoji} />}
			<span>{filter?.name}</span>
		</TriStateCheckbox>
	)
}
