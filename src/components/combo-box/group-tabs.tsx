import { cn } from '@/lib/utils'
import * as UI_Msgs from '@/messages/ui.messages'
import { tr } from '@/systems/messages.client'

import { ALL_GROUPS, type GroupPrefixRenderer, type ResolvedGroup } from './options.ts'

// One tab per group plus a leading "all" tab. Mousedown is swallowed so switching tabs never pulls focus
// out of the search input: the user's next keystroke still types into the filter.
export function GroupTabs(props: { groups: readonly ResolvedGroup[]; value: string; onChange: (group: string) => void }) {
	return (
		<div role="tablist" className="flex shrink-0 items-center gap-1 overflow-x-auto border-b px-1 py-1">
			{[{ key: ALL_GROUPS, label: tr.text(UI_Msgs.allGroups()), prefix: '' }, ...props.groups].map((group) => (
				<button
					key={group.key}
					type="button"
					role="tab"
					aria-selected={props.value === group.key}
					onMouseDown={(e) => e.preventDefault()}
					onClick={() => props.onChange(group.key)}
					className={cn(
						'whitespace-nowrap rounded px-2 py-0.5 text-xs transition-colors',
						props.value === group.key ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
					)}
				>
					{group.label}
				</button>
			))}
		</div>
	)
}

// An option's label with its group shown ahead of it. `render` replaces the default badge; passing false
// for the component's renderGroupPrefix prop drops the prefix before this is ever rendered. The separating
// space is a text node rather than a margin so the rendered text reads "GC Narva", which is what a
// screen reader announces and what a test asserting on the trigger's text sees.
export function PrefixedLabel(props: { prefix?: string | null; label: React.ReactNode; render?: GroupPrefixRenderer }) {
	if (!props.prefix) return props.label
	return (
		<>
			{props.render ? props.render(props.prefix) : <span className="shrink-0 text-muted-foreground">{props.prefix}</span>} {props.label}
		</>
	)
}
