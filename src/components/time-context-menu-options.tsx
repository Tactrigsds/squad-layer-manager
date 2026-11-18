import type * as Interactions from '@/components/feed/interactions'
import * as Selection from '@/components/feed/selection'
import * as APP_Msgs from '@/messages/app.messages'
import * as CHAT_Msgs from '@/messages/chat.messages'
import * as Clipboard from '@/systems/clipboard.client'
import { tr } from '@/systems/messages.client'

import { ContextMenuItem, ContextMenuShortcut } from './ui/context-menu'

function copyRows(rows: NonNullable<Interactions.TimeMenuTarget['rows']>) {
	const host = Selection.hostOf(rows.hostKey)
	if (host) Selection.copySelection(host, rows.selection)
}

export default function TimeContextMenuOptions(props: { target: Interactions.TimeMenuTarget }) {
	const { target } = props
	const whole = target.rows?.wholeSelection ?? false
	return (
		<>
			<ContextMenuItem onSelect={() => void Clipboard.copy(new Date(target.time).toISOString(), tr.text(CHAT_Msgs.timestampNoun()))}>
				{tr.text(CHAT_Msgs.copyTimestampIso())}
			</ContextMenuItem>
			{target.link && (
				<ContextMenuItem onSelect={() => void Clipboard.copy(target.link!.url, tr.text(APP_Msgs.linkNoun()))}>
					<span className="flex flex-col">
						{tr.text(whole ? CHAT_Msgs.copyLinkToSelection() : CHAT_Msgs.copyLinkToRow())}
						{target.link.caveat && <span className="text-2xs text-muted-foreground">{target.link.caveat}</span>}
					</span>
					{whole && <ContextMenuShortcut>{CHAT_Msgs.selectionShortcuts.copyLink}</ContextMenuShortcut>}
				</ContextMenuItem>
			)}
			{target.rows && (
				<ContextMenuItem onSelect={() => copyRows(target.rows!)}>
					{tr.text(whole ? CHAT_Msgs.copySelectionAsText() : CHAT_Msgs.copyRowAsText())}
					{whole && <ContextMenuShortcut>{CHAT_Msgs.selectionShortcuts.copyText}</ContextMenuShortcut>}
				</ContextMenuItem>
			)}
		</>
	)
}
