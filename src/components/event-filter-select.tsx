import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type * as CHAT from '@/models/chat.models'

import * as Icons from 'lucide-react'

const labels: Record<CHAT.SecondaryFilterState, string> = {
	ALL: 'All',
	DEFAULT: 'Default',
	CHAT: 'Chat Only',
	ADMIN: 'Admin Only',
}

export default function EventFilterSelect(props: {
	value: CHAT.SecondaryFilterState
	onValueChange: (value: CHAT.SecondaryFilterState) => void
	variant?: 'default' | 'outline' | 'ghost' | 'link'
	zIndex?: number
	open?: boolean
	onOpenChange?: (open: boolean) => void
}) {
	return (
		<DropdownMenu open={props.open} onOpenChange={props.onOpenChange}>
			<DropdownMenuTrigger asChild>
				<Button variant={props?.variant ?? 'outline'} size="sm" className="h-8 gap-2">
					<Icons.Filter className="h-4 w-4" />
					<span className="text-xs">{labels[props.value]}</span>
					<Icons.ChevronDown className="h-3 w-3 ml-1" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent style={{ zIndex: props.zIndex }} align="end">
				<DropdownMenuRadioGroup value={props.value} onValueChange={props.onValueChange as (value: string) => void}>
					{Object.entries(labels).map(([key, label]) => (
						<DropdownMenuRadioItem key={key} value={key}>
							{label}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
