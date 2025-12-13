import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type * as CHAT from '@/models/chat.models'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import * as Icons from 'lucide-react'
import * as Zus from 'zustand'

export default function EventFilterSelect() {
	const value = Zus.useStore(SquadServerClient.ChatStore, s => s.eventFilterState)
	const onValueChange = Zus.useStore(SquadServerClient.ChatStore, s => s.setEventFilterState)
	const labels: Record<CHAT.EventFilterState, string> = {
		ALL: 'All',
		DEFAULT: 'Default',
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
