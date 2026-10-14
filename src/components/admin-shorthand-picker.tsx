import * as Icons from 'lucide-react'
import React from 'react'

import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import * as AMS_Msgs from '@/messages/admin-message-shorthands.messages'
import type * as AMS from '@/models/admin-message-shorthands.models'
import { tr } from '@/systems/messages.client'

// Drops a configured preset into a free-text chat box: unlike a select it holds no state of its own, so the
// text stays editable afterwards. `preview` renders the text a pick would insert, shown under each label.
export function AdminShorthandPicker({
	shorthands,
	preview,
	onPick,
	disabled,
	className,
	title,
	tourId,
}: {
	shorthands: AMS.AdminMessageShorthand[]
	preview: (shorthand: AMS.AdminMessageShorthand) => string
	onPick: (shorthand: AMS.AdminMessageShorthand) => void
	disabled?: boolean
	className?: string
	title?: string
	tourId?: string
}) {
	const [open, setOpen] = React.useState(false)
	if (shorthands.length === 0) return null

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					data-tour={tourId}
					size="sm"
					variant="outline"
					className={cn('h-auto self-stretch w-7 p-0 shrink-0', className)}
					disabled={disabled}
					title={title ?? tr.text(AMS_Msgs.fillWithShorthand())}
					aria-label={tr.text(AMS_Msgs.presetReasonPicker())}
				>
					<Icons.ListPlus className="h-3.5 w-3.5" />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-56 p-0">
				<Command>
					<CommandInput placeholder={tr.text(AMS_Msgs.searchShorthands())} />
					<CommandList>
						<CommandEmpty>{tr.text(AMS_Msgs.noShorthandsFound())}</CommandEmpty>
						<CommandGroup>
							{shorthands.map((shorthand) => (
								<CommandItem
									key={shorthand.label}
									value={shorthand.label}
									keywords={shorthand.keywords}
									onSelect={() => {
										onPick(shorthand)
										setOpen(false)
									}}
								>
									<span className="flex flex-col gap-0.5 min-w-0">
										<span>{shorthand.label}</span>
										<span className="text-xs text-muted-foreground truncate">{preview(shorthand)}</span>
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
