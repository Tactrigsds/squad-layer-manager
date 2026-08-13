import React from 'react'

import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import * as Typo from '@/lib/typography'
import { cn } from '@/lib/utils.ts'
import * as UI_Msgs from '@/messages/ui.messages'
import { tr } from '@/systems/messages.client'

// Block/compact for a YAML editor's buffer, shared so both editors carry the same control. Switching re-renders
// what is in the buffer, which means parsing it first, so an unparsable buffer disables the switch until the
// text is valid again.
export default function YamlCompactSwitch(props: { compact: boolean; disabled: boolean; onChange: (compact: boolean) => void }) {
	const id = React.useId()
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<div className="flex items-center gap-1.5">
					<Switch id={id} checked={props.compact} disabled={props.disabled} onCheckedChange={props.onChange} />
					<Label htmlFor={id} className={cn(Typo.Small, props.disabled && 'text-muted-foreground')}>
						{tr.text(UI_Msgs.compact())}
					</Label>
				</div>
			</TooltipTrigger>
			<TooltipContent>{tr.text(UI_Msgs.compactHint())}</TooltipContent>
		</Tooltip>
	)
}
