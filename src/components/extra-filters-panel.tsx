import { Button, buttonVariants } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import * as Gen from '@/lib/generator.ts'
import * as Typography from '@/lib/typography.ts'
import { cn } from '@/lib/utils.ts'
import * as F from '@/models/filter.models.ts'
import * as LQY from '@/models/layer-queries.models.ts'
import * as FilterEntityClient from '@/systems.client/filter-entity.client'
import { CheckIcon } from '@radix-ui/react-icons'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import ComboBoxMulti from './combo-box/combo-box-multi.tsx'
import EmojiDisplay from './emoji-display.tsx'
import FilterEntitySelect, { FilterEntityLabel } from './filter-entity-select.tsx'
import { ScrollArea, ScrollBar } from './ui/scroll-area.tsx'
import { TriState, TriStateCheckbox, TriStateCheckboxDisplay } from './ui/tri-state-checkbox.tsx'

export default function ExtraFiltersPanel({ store }: { store: Zus.StoreApi<LQY.ExtraQueryFiltersStore> }) {
	const filterEntities = FilterEntityClient.useFilterEntities()
	const extraFiltersState = Zus.useStore(store)
	const scrollRef = React.useRef<HTMLDivElement>(null)
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

	const checkScrollability = React.useCallback(() => {
		if (scrollRef.current) {
			const viewport = scrollRef.current.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement | null
			if (viewport) {
				const { scrollLeft, scrollWidth, clientWidth } = viewport
				setCanScrollLeft(scrollLeft > 0)
				setCanScrollRight(scrollLeft < scrollWidth - clientWidth - 1)
			}
		}
	}, [])

	React.useEffect(() => {
		const viewport = scrollRef.current?.querySelector('[data-radix-scroll-area-viewport]')
		if (viewport) {
			checkScrollability()
			viewport.addEventListener('scroll', checkScrollability)
			window.addEventListener('resize', checkScrollability)

			// Use ResizeObserver to detect content size changes
			const resizeObserver = new ResizeObserver(checkScrollability)
			resizeObserver.observe(viewport)

			return () => {
				viewport.removeEventListener('scroll', checkScrollability)
				window.removeEventListener('resize', checkScrollability)
				resizeObserver.disconnect()
			}
		}
	}, [checkScrollability, extraFiltersState.filters])

	const onSelect = React.useCallback((update: React.SetStateAction<string[]>) => {
		const state = store.getState()
		const filters = typeof update === 'function'
			? update(Array.from(state.filters).filter(filterId => !state.readOnlyFilters.has(filterId)))
			: update
		store.getState().select(filters)
	}, [store])

	const extraFilterIds: F.FilterEntityId[] = []
	const poolFilterIds: F.FilterEntityId[] = []
	for (const filterId of extraFiltersState.filters) {
		if (extraFiltersState.readOnlyFilters.has(filterId)) {
			poolFilterIds.push(filterId)
		} else {
			extraFilterIds.push(filterId)
		}
	}

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
						return <FilterCheckbox key={filterId} filterId={filterId} store={store} />
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
			<ComboBoxMulti options={options} values={extraFilterIds} onSelect={onSelect}>
				<Button title="Edit extra filters" variant="ghost" size="icon">
					<Icons.Edit />
				</Button>
			</ComboBoxMulti>
			<div className="flex flex-row gap-2 w-max">
				{poolFilterIds.map((filterId) => {
					return <FilterCheckbox key={filterId} filterId={filterId} store={store} />
				})}
			</div>
		</div>
	)
}

function FilterCheckbox({ filterId, store }: { filterId: string; store: Zus.StoreApi<LQY.ExtraQueryFiltersStore> }) {
	const state = Zus.useStore(store)
	const checked = state.activated.find((s) => s.filterId === filterId)?.state ?? ('disabled' as const)
	const filter = FilterEntityClient.useFilterEntities().get(filterId)
	const states = ['disabled', 'regular', 'inverted'] as const
	const handleClick = () => {
		const nextState = states[(states.indexOf(checked) + 1) % states.length]
		store.getState().setFilterState(filterId, nextState)
	}

	const btn = (
		<Button title={checked === 'regular' ? 'filtering' : checked} onClick={handleClick} variant="ghost" size="sm">
			{filter?.emoji && <EmojiDisplay size="sm" emoji={filter?.emoji} />}
			<span>{filter?.name}</span>
			<TriStateCheckboxDisplay checked={checked} />
		</Button>
	)
	return btn
}
