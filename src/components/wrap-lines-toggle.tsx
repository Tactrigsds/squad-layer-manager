import * as Icons from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import * as UI_Msgs from '@/messages/ui.messages'
import { tr } from '@/systems/messages.client'

// Turns line wrapping on and off in an output or feed. The caller sets `data-nowrap` on the content while `wrap` is
// false; index.css keeps each feed row on one line under it.
export function WrapLinesToggle(props: { wrap: boolean; onToggle: () => void; variant?: 'secondary' | 'ghost'; className?: string }) {
	return (
		<Button
			type="button"
			size="icon"
			variant={props.variant ?? 'secondary'}
			aria-pressed={props.wrap}
			aria-label={tr.text(UI_Msgs.wrapLines())}
			title={tr.text(UI_Msgs.wrapLines())}
			className={cn('shrink-0 text-muted-foreground aria-pressed:text-primary', props.className)}
			onClick={props.onToggle}
		>
			<Icons.WrapText className="h-3.5 w-3.5" />
		</Button>
	)
}
