import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type * as AAR from '@/models/admin-action-reasons.models'
import * as Icons from 'lucide-react'
import React from 'react'

// Drops a configured preset into a free-text chat box: unlike a select it holds no state of its own, so the
// text stays editable afterwards. `preview` renders the text a pick would insert, shown under each label.
export function AdminReasonPicker({ reasons, preview, onPick, disabled, className, title }: {
	reasons: AAR.AdminActionReason[]
	preview: (reason: AAR.AdminActionReason) => string
	onPick: (reason: AAR.AdminActionReason) => void
	disabled?: boolean
	className?: string
	title?: string
}) {
	const [open, setOpen] = React.useState(false)
	if (reasons.length === 0) return null

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					size="sm"
					variant="outline"
					className={cn('h-auto self-stretch w-7 p-0 shrink-0', className)}
					disabled={disabled}
					title={title ?? 'Fill the box with a preset reason'}
					aria-label="Preset reason"
				>
					<Icons.ListPlus className="h-3.5 w-3.5" />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-56 p-0">
				<Command>
					<CommandInput placeholder="Search reasons..." />
					<CommandList>
						<CommandEmpty>No reasons found.</CommandEmpty>
						<CommandGroup>
							{reasons.map(reason => (
								<CommandItem
									key={reason.label}
									value={reason.label}
									keywords={reason.aliases}
									onSelect={() => {
										onPick(reason)
										setOpen(false)
									}}
								>
									<span className="flex flex-col gap-0.5 min-w-0">
										<span>{reason.label}</span>
										<span className="text-xs text-muted-foreground truncate">{preview(reason)}</span>
									</span>
								</CommandItem>
							))}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	)
}
