import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type * as CHAT from '@/models/chat.models'
import * as Icons from 'lucide-react'
import React from 'react'

interface EventFilterSelectProps {
	value: CHAT.EventFilterState
	onValueChange: (value: CHAT.EventFilterState) => void
}

export default function EventFilterSelect({ value, onValueChange }: EventFilterSelectProps) {
	const labels: Record<CHAT.EventFilterState, string> = {
		ALL: 'All Events',
		CHAT: 'Chat Only',
		ADMIN: 'Admin Only',
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="outline" size="sm" className="h-8 gap-2">
					<Icons.Filter className="h-4 w-4" />
					<span className="text-xs">{labels[value]}</span>
					<Icons.ChevronDown className="h-3 w-3 ml-1" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuRadioGroup value={value} onValueChange={onValueChange as (value: string) => void}>
					<DropdownMenuRadioItem value="ALL">All Events</DropdownMenuRadioItem>
					<DropdownMenuRadioItem value="CHAT">Chat Only</DropdownMenuRadioItem>
					<DropdownMenuRadioItem value="ADMIN">Admin Chat Only</DropdownMenuRadioItem>
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
