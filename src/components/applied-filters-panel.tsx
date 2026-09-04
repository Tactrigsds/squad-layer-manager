import * as Icons from 'lucide-react'
import React from 'react'

import { Button } from '@/components/ui/button'
import * as AppliedFiltersPrt from '@/frame-partials/applied-filters.partial.ts'
import type * as SquadServerFrame from '@/frames/squad-server.frame.ts'
import * as Rx from '@/lib/rxjs'
import * as Zus from '@/lib/zustand.ts'
import * as F_Msgs from '@/messages/filter.messages'
import * as SETTINGS_Msgs from '@/messages/settings.messages'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import { tr } from '@/systems/messages.client'

import ComboBoxMulti from './combo-box/combo-box-multi.tsx'
import EmojiDisplay from './emoji-display.tsx'
import { FilterEntityLabel } from './filter-entity-select.tsx'
import { ScrollArea, ScrollBar } from './ui/scroll-area.tsx'
import { TriStateCheckbox } from './ui/tri-state-checkbox.tsx'

export default function AppliedFiltersPanel(props: { stores: Partial<SquadServerFrame.KeyProp> & AppliedFiltersPrt.KeyProp }) {
	const scrollRef = React.useRef<HTMLDivElement>(null)
	const squadServer = props.stores.squadServer ?? null
	const extraFilterIds = Zus.useStore(
		props.stores.appliedFilters,
		squadServer,
		AppliedFiltersPrt.ExtraFiltersStore,
		AppliedFiltersPrt.Sel.extraFilterIds,
	)
	const selectableFilterIds = Zus.useStore(squadServer, AppliedFiltersPrt.Sel.selectableFilterIds)
	const addableFilters = Zus.useStore(squadServer, FilterEntityClient.filterEntities$, AppliedFiltersPrt.Sel.addableFilters)
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

			const sub = Rx.merge(visible$, Rx.fromEvent(viewport, 'scroll'), Rx.fromEvent(window, 'resize')).subscribe(checkScrollability)

			// Use ResizeObserver to detect content size changes
			const resizeObserver = new ResizeObserver(checkScrollability)
			resizeObserver.observe(viewport)

			return () => {
				sub.unsubscribe()
				resizeObserver.disconnect()
			}
		}
	}, [extraFilterIds])

	const options = addableFilters.map((filter) => ({ value: filter.id, label: <FilterEntityLabel filter={filter} /> }))

	return (
		<div data-tour="applied-filters" className="flex items-center gap-2 min-w-0">
			<ComboBoxMulti
				options={options}
				values={extraFilterIds}
				onSelect={(update) => AppliedFiltersPrt.Actions.selectExtraFilters(props.stores, update)}
			>
				<Button
					title={tr.text(F_Msgs.editExtraFilters())}
					aria-label={tr.text(F_Msgs.editExtraFilters())}
					variant="ghost"
					size="icon-sm"
				>
					<Icons.Edit />
				</Button>
			</ComboBoxMulti>
			<Button
				variant="ghost"
				size="icon-sm"
				className="shrink-0 data-[canscroll=false]:hidden"
				data-canscroll={canScroll}
				onClick={scrollLeft}
				onDoubleClick={scrollToStart}
				disabled={!canScrollLeft}
				title={tr.text(F_Msgs.scrollLeft())}
			>
				<Icons.ChevronLeft />
			</Button>
			<ScrollArea ref={scrollRef} className="max-w-[55vw] min-w-0">
				<div className="flex flex-row gap-1 w-max">
					{extraFilterIds.map((filterId) => {
						return <FilterCheckbox key={filterId} filterId={filterId} stores={{ appliedFilters: props.stores.appliedFilters }} />
					})}
				</div>
				<ScrollBar orientation="horizontal" />
			</ScrollArea>
			<Button
				variant="ghost"
				size="icon-sm"
				className="shrink-0 data-[canscroll=false]:hidden"
				data-canscroll={canScroll}
				onClick={scrollRight}
				onDoubleClick={scrollToEnd}
				disabled={!canScrollRight}
				title={tr.text(F_Msgs.scrollRight())}
			>
				<Icons.ChevronRight />
			</Button>
			<span className="w-px h-4 bg-line shadow-[1px_0_0_var(--line-soft)]" />
			<div className="flex flex-row gap-1 w-max">
				<PoolFilterCheckbox stores={props.stores} />
				{selectableFilterIds.map((filterId) => {
					return <FilterCheckbox key={filterId} filterId={filterId} stores={{ appliedFilters: props.stores.appliedFilters }} />
				})}
			</div>
			<Button
				title={tr.text(F_Msgs.disableAllFilters())}
				variant="ghost"
				size="icon-sm"
				onClick={() => {
					AppliedFiltersPrt.Actions.disableAllAppliedFilters(props.stores)
				}}
			>
				<Icons.Trash2 />
			</Button>
		</div>
	)
}

// the pool filter is pinned; out-of-pool layers surfaced by the inverted/disabled states stay unselectable for
// users without queue:force-write, so no state needs to be locked away
export function PoolFilterCheckbox({ stores }: { stores: Partial<SquadServerFrame.KeyProp> & AppliedFiltersPrt.KeyProp }) {
	const poolFilter = Zus.useStore(stores.squadServer ?? null, AppliedFiltersPrt.Sel.poolFilter)
	const poolApplyAs = Zus.useStore(stores.appliedFilters, (s) => s.appliedFilters.poolApplyAs)
	const filter = FilterEntityClient.useFilterEntities().get(poolFilter?.filterId as string)
	if (!poolFilter || !filter) return

	const emoji = poolApplyAs === 'inverted' ? (filter.invertedEmoji ?? filter.emoji) : filter.emoji
	return (
		<TriStateCheckbox
			checked={poolApplyAs}
			onCheckedChange={(applyAs) => AppliedFiltersPrt.Actions.setPoolApplyAs(stores, applyAs)}
			title={tr.text(SETTINGS_Msgs.poolStateTitles[poolApplyAs])}
		>
			{emoji && <EmojiDisplay size="sm" emoji={emoji} />}
			<span>{filter.name}</span>
		</TriStateCheckbox>
	)
}

export function FilterCheckbox({ filterId, stores }: { filterId: string; stores: AppliedFiltersPrt.KeyProp }) {
	const storeAppliedState = Zus.useStore(stores.appliedFilters, (s) => s.appliedFilters.filterStates.get(filterId) ?? 'disabled')
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
