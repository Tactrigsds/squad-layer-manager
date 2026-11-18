import * as Icons from 'lucide-react'

import { Button } from '@/components/ui/button'
import * as CMD_Msgs from '@/messages/command.messages'
import * as Clipboard from '@/systems/clipboard.client'
import { tr } from '@/systems/messages.client'

export function CopyableCommand({ cmdString, chatCommand }: { cmdString: string; chatCommand: 'ChatToAdmin' | 'ChatToAll' }) {
	const copy = async () => {
		const consoleCommand = `${chatCommand} ${cmdString}`
		await Clipboard.copy(consoleCommand, consoleCommand)
	}
	return (
		<div className="flex items-center gap-1">
			<code className="px-2 py-1 bg-muted rounded text-sm font-mono ltr-isolate">{cmdString}</code>
			<Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={copy} aria-label={tr.text(CMD_Msgs.copyCommand(cmdString))}>
				<Icons.Copy className="h-3 w-3" />
			</Button>
		</div>
	)
}
