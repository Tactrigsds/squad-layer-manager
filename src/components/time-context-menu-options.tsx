import type * as Interactions from '@/components/feed/interactions'
import * as Selection from '@/components/feed/selection'
import { toast } from '@/lib/toast'
import * as CHAT_Msgs from '@/messages/chat.messages'
import { tr } from '@/systems/messages.client'

import { ContextMenuItem } from './ui/context-menu'

function copy(text: string, copied: Parameters<typeof tr.toast>[0]) {
	void navigator.clipboard.writeText(text).then(() => toast(...tr.toast(copied)))
}

function copyRows(rows: NonNullable<Interactions.TimeMenuTarget['rows']>) {
	const host = Selection.hostOf(rows.hostKey)
	if (host) Selection.copySelection(host, rows.selection)
}

export default function TimeContextMenuOptions(props: { target: Interactions.TimeMenuTarget }) {
	const { target } = props
	const whole = target.rows?.wholeSelection ?? false
	return (
		<>
			<ContextMenuItem onSelect={() => copy(new Date(target.time).toISOString(), CHAT_Msgs.timestampCopied())}>
				{tr.text(CHAT_Msgs.copyTimestampIso())}
			</ContextMenuItem>
			{target.link && (
				<ContextMenuItem onSelect={() => copy(target.link!.url, CHAT_Msgs.linkToRowsCopied())}>
					<span className="flex flex-col">
						{tr.text(whole ? CHAT_Msgs.copyLinkToSelection() : CHAT_Msgs.copyLinkToRow())}
						{target.link.caveat && <span className="text-2xs text-muted-foreground">{target.link.caveat}</span>}
					</span>
				</ContextMenuItem>
			)}
			{target.rows && (
				<ContextMenuItem onSelect={() => copyRows(target.rows!)}>
					{tr.text(whole ? CHAT_Msgs.copySelectionAsText() : CHAT_Msgs.copyRowAsText())}
				</ContextMenuItem>
			)}
		</>
	)
}
