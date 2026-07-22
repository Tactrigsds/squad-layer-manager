import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import * as CHAT from '@/models/chat.models'

import * as Icons from 'lucide-react'

export default function EventFilterSelect(props: {
	value: CHAT.SecondaryFilterState
	onValueChange: (value: CHAT.SecondaryFilterState) => void
	// defaults to every filter. pass a subset to hide filters that don't apply to the containing view
	options?: CHAT.SecondaryFilterState[]
	// omit when the containing view has no player selection for this to restrict against (e.g. a single-player feed)
	selectedOnly?: boolean
	onSelectedOnlyChange?: (value: boolean) => void
	variant?: 'default' | 'outline' | 'ghost' | 'link'
	open?: boolean
	onOpenChange?: (open: boolean) => void
}) {
	const labels = CHAT.SECONDARY_FILTER_LABELS
	const options = props.options ?? (Object.keys(labels) as CHAT.SecondaryFilterState[])
	return (
		<DropdownMenu open={props.open} onOpenChange={props.onOpenChange}>
			<DropdownMenuTrigger asChild>
				<Button variant={props?.variant ?? 'outline'} size="sm" className="h-8 gap-2">
					<Icons.Filter className="h-4 w-4" />
					<span className="text-xs">{labels[props.value]}</span>
					<Icons.ChevronDown className="h-3 w-3 ml-1" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuRadioGroup value={props.value} onValueChange={props.onValueChange as (value: string) => void}>
					{options.map((option) => (
						<DropdownMenuRadioItem key={option} value={option}>
							{labels[option]}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
				{props.onSelectedOnlyChange && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuCheckboxItem
							checked={!!props.selectedOnly}
							onSelect={e => e.preventDefault()}
							onCheckedChange={props.onSelectedOnlyChange}
						>
							Selected Only
						</DropdownMenuCheckboxItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
