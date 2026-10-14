import type React from 'react'

import * as SquadServerFrame from '@/frames/squad-server.frame'
import { cn } from '@/lib/utils'
import * as SM_Msgs from '@/messages/squad.messages'
import { tr } from '@/systems/messages.client'

/**
 * Stands in for a value hidden with spoilers. Renders nothing of the value, so its size and shape give nothing away.
 * A click shows every spoiler on the server at once. `children` is what it reads while the pointer is elsewhere.
 */
export function SpoilerRedaction(props: { stores: SquadServerFrame.KeyProp; className?: string; children?: React.ReactNode }) {
	return (
		<button
			type="button"
			aria-label={tr.text(SM_Msgs.showSpoilers())}
			className={cn(
				'group relative inline-flex items-center justify-center rounded-sm border border-line-soft spoiler-hatch cursor-pointer text-text-3',
				props.className,
			)}
			onClick={(e) => {
				// it sits inside clickable rows, which would otherwise take the click as their own
				e.stopPropagation()
				SquadServerFrame.Actions.setShowSpoilers(props.stores, true)
			}}
		>
			{props.children && (
				<span className="transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0">{props.children}</span>
			)}
			<span className="absolute inset-0 flex items-center justify-center rounded-sm bg-ctl text-[11px] font-semibold text-text opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
				{tr.text(SM_Msgs.revealSpoilers())}
			</span>
		</button>
	)
}
