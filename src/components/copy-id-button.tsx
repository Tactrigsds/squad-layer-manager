import * as Icons from 'lucide-react'
import React from 'react'

import { cn } from '@/lib/utils'
import * as SM_Msgs from '@/messages/squad.messages'
import { useZIndex, ZI_OFFSETS } from '@/models/zindex'
import { tr } from '@/systems/messages.client'

// A labeled player id ("steam: 7656...") that copies itself on click.
//
// The confirmation replaces the id in place rather than floating over it, which is what a tooltip would do: the
// content only goes invisible, so the button keeps the width it already had and nothing around it moves. Being
// invisible rather than covered also means no background has to match whatever the button is sitting on.
//
// Right-justified, and clipped by the button rather than widening it: on one too narrow for the whole word the
// left of it is what goes, since that is the end a right-justified overflow runs off.
export function CopyIdButton({ kind, id }: { kind: SM_Msgs.IdKind; id: string }) {
	const [copied, setCopied] = React.useState(false)
	const timeoutRef = React.useRef<ReturnType<typeof setTimeout>>(null)
	const zIndex = useZIndex(ZI_OFFSETS.MINOR_CEILING)

	const handleClick = () => {
		void navigator.clipboard.writeText(id)
		setCopied(true)
		if (timeoutRef.current) clearTimeout(timeoutRef.current)
		timeoutRef.current = setTimeout(() => setCopied(false), 1500)
	}

	React.useEffect(
		() => () => {
			if (timeoutRef.current) clearTimeout(timeoutRef.current)
		},
		[],
	)

	const hidden = copied && 'invisible'
	return (
		<button
			type="button"
			className="relative inline-flex min-w-0 max-w-full items-center gap-1 overflow-hidden hover:text-foreground transition-colors cursor-pointer"
			title={tr.text(SM_Msgs.copyIdHint(kind))}
			onClick={handleClick}
		>
			<span className={cn('font-mono text-muted-foreground', hidden)}>{SM_Msgs.idKindLabels[kind]}:</span>
			<span className={cn('min-w-0 truncate font-mono', hidden)}>{id}</span>
			<Icons.Copy className={cn('h-3 w-3', hidden)} />
			{copied && (
				<span role="status" style={{ zIndex }} className="absolute inset-0 flex items-center justify-end font-mono whitespace-nowrap">
					{tr.text(SM_Msgs.copiedFeedback())}
				</span>
			)}
		</button>
	)
}
