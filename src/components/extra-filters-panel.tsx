import { Button, buttonVariants } from '@/components/ui/button'

import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import * as SelectLayersFrame from '@/frames/select-layers.frame.ts'
import { useDebounced } from '@/hooks/use-debounce.ts'
import * as FRM from '@/lib/frame.ts'
import * as Gen from '@/lib/generator.ts'
import * as Typography from '@/lib/typography.ts'
import { cn } from '@/lib/utils.ts'
import * as ZusUtils from '@/lib/zustand.ts'
import * as F from '@/models/filter.models.ts'
import * as LQY from '@/models/layer-queries.models.ts'
import * as FilterEntityClient from '@/systems.client/filter-entity.client'
import * as QD from '@/systems.client/queue-dashboard.ts'
import * as ServerSettingsClient from '@/systems.client/server-settings.client.ts'
import { CheckIcon } from '@radix-ui/react-icons'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import ComboBoxMulti from './combo-box/combo-box-multi.tsx'
import EmojiDisplay from './emoji-display.tsx'
import FilterEntitySelect, { FilterEntityLabel } from './filter-entity-select.tsx'
import { ScrollArea, ScrollBar } from './ui/scroll-area.tsx'
import { TriState, TriStateCheckbox, TriStateCheckboxDisplay } from './ui/tri-state-checkbox.tsx'

export default function ExtraFiltersPanel(props: { frameKey: SelectLayersFrame.Key }) {
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
	}, [checkScrollability, extraFilters])

	const extraFilterIds: F.FilterEntityId[] = Array.from(extraFilters)
	const poolFilterIds: F.FilterEntityId[] = Zus.useStore(
		ServerSettingsClient.Store,
		ZusUtils.useShallow(s => s.saved.queue.mainPool.filters.map(c => c.filterId)),
	)

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
				<Button title="Edit extra filters" variant="ghost" size="icon">
					<Icons.Edit />
				</Button>
			</ComboBoxMulti>
			<div className="flex flex-row gap-2 w-max">
				{poolFilterIds.map((filterId) => {
					return <FilterCheckbox key={filterId} filterId={filterId} frameKey={props.frameKey} />
				})}
			</div>
		</div>
	)
}

function FilterCheckbox({ filterId, frameKey }: { filterId: string; frameKey: SelectLayersFrame.Key }) {
	const [appliedState, setAppliedFilterState] = SelectLayersFrame.useSelectedSelectLayersState(
		frameKey,
		useShallow(s => [s.appliedFilters.get(filterId)!, s.setAppliedFilterState]),
	)
	// const [appliedState, setAppliedFilterState] = React.useState
	const filter = FilterEntityClient.useFilterEntities().get(filterId)
	const states = ['disabled', 'regular', 'inverted'] as const
	const handleChange = (applyAs: (typeof states)[number]) => {
		setAppliedFilterState(filterId, applyAs)
	}

	const changeThrottled = useDebounced<(typeof states)[number]>({ delay: 0, mode: 'throttle', onChange: handleChange })
	const handleClick = (e: React.MouseEvent) => {
		if (e.button === 2) e.preventDefault()
		if (e.ctrlKey || e.metaKey) {
			changeThrottled('disabled')
		} else {
			const direction = e.button === 2 ? -1 : 1
			const nextState = states[(states.indexOf(appliedState) + direction + states.length) % states.length]
			changeThrottled(nextState)
		}
	}

	const titleMap = {
		disabled: 'Not filtering',
		regular: 'Filtering',
		inverted: 'Inverted',
	}

	const btn = (
		<Button title={titleMap[appliedState]} onClick={handleClick} onContextMenu={handleClick} variant="ghost" size="sm">
			{filter?.emoji && <EmojiDisplay size="sm" emoji={filter?.emoji} />}
			<span>{filter?.name}</span>
			<TriStateCheckboxDisplay state={appliedState} />
		</Button>
	)
	return btn
}
