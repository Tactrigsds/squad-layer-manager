import type React from 'react'

import { cn } from '@/lib/utils'

/**
 * Folder tabs over an `fd-tabbody`. `tabId` and `panelId` name each tab and the body it controls, so the two can
 * point at each other (aria-controls / aria-labelledby). `leading` pushes the tabs to the end of the row.
 */
export function TabBar<T extends string>(props: {
	tabs: { value: T; label: React.ReactNode; count?: number }[]
	value: T | null
	onChange: (value: T) => void
	tabId: (value: T) => string
	panelId: (value: T) => string
	tourId?: (value: T) => string
	className?: string
	leading?: React.ReactNode
	trailing?: React.ReactNode
	ref?: React.RefObject<HTMLDivElement | null>
}) {
	return (
		// Contained, so the row takes its width from its parent instead of reporting its labels' full width upwards. A
		// parent that sizes to its content (the phone dashboard's scroll area) would otherwise grow past the screen
		// rather than let the labels truncate.
		<div ref={props.ref} className={cn('fd-tabs shrink-0 [contain:inline-size]', props.className)}>
			{props.leading && <span className="me-auto flex min-w-0 items-end gap-2 pb-1">{props.leading}</span>}
			<div role="tablist" className="contents">
				{props.tabs.map((tab) => (
					<button
						key={tab.value}
						type="button"
						role="tab"
						data-tour={props.tourId?.(tab.value)}
						id={props.tabId(tab.value)}
						aria-selected={props.value === tab.value}
						aria-controls={props.panelId(tab.value)}
						data-state={props.value === tab.value ? 'active' : 'inactive'}
						// only the active tab is in the tab order; arrow keys are the expected way to move between
						// tabs, and roving tabindex is what tells assistive tech that
						tabIndex={props.value === tab.value ? 0 : -1}
						className="fd-tab min-w-0"
						onClick={() => props.onChange(tab.value)}
					>
						<span className="truncate">{tab.label}</span>
						{tab.count !== undefined && <span className="fd-tab-cnt">{tab.count}</span>}
					</button>
				))}
			</div>
			{props.trailing && <span className={cn('flex min-w-0 items-end gap-2 pb-1', !props.leading && 'ms-auto')}>{props.trailing}</span>}
		</div>
	)
}
