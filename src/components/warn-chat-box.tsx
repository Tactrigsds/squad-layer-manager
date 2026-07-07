import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import * as RBAC from '@/rbac.models'
import * as RbacClient from '@/systems/rbac.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as UsersClient from '@/systems/users.client'
import * as WarnChat from '@/systems/warn-chat.client'
import * as Icons from 'lucide-react'
import React from 'react'

function warnTargetsEqual(a: WarnChat.WarnFocusTarget, b: WarnChat.WarnFocusTarget) {
	if (a.kind === 'player' && b.kind === 'player') return a.playerId === b.playerId
	if (a.kind === 'squad' && b.kind === 'squad') return a.uniqueSquadId === b.uniqueSquadId
	return a.kind === b.kind
}

// Compact warn-chat input reused by the player- and squad-details windows so admins can warn a target
// straight from its window. `bodyPrefix` (e.g. "@Squad3") is prepended to the message body; when the
// username checkbox is checked its prefix sits ahead of it, matching ServerChatBox's ordering.
export default function WarnChatBox({
	serverId,
	playerIds,
	bodyPrefix,
	placeholder,
	focusTarget,
	className,
}: {
	serverId: string
	playerIds: string[]
	bodyPrefix?: string
	placeholder?: string
	focusTarget?: WarnChat.WarnFocusTarget
	className?: string
}) {
	const [message, setMessage] = React.useState('')
	const [prefixName, setPrefixName] = React.useState(false)
	const textareaRef = React.useRef<HTMLTextAreaElement>(null)

	WarnChat.useWarnFocusRequest(
		t => !!focusTarget && warnTargetsEqual(t, focusTarget),
		() => WarnChat.focusWhenVisible(() => textareaRef.current),
	)
	const username = UsersClient.useLoggedInUser()?.displayName
	const warnDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:warn-players'))
	const warnPlayersMutation = SquadServerClient.useWarnPlayersMutation()
	const pending = warnPlayersMutation.isPending

	const noTargets = playerIds.length === 0
	const sendDisabled = pending || !!warnDenied || noTargets || !message.trim()

	async function send() {
		const text = message.trim()
		if (!text || sendDisabled) return
		const body = bodyPrefix ? `${bodyPrefix} ${text}` : text
		const composed = prefixName && username ? `${username}: ${body}` : body
		try {
			const res = await warnPlayersMutation.mutateAsync({ serverId, playerIds, reason: composed })
			if (res.code !== 'ok') {
				toast.error('Failed to send', { description: res.code })
				return
			}
			setMessage('')
		} catch (e) {
			console.error(e)
			toast.error('Failed to send')
		}
	}

	// orange "targeted warn" accent, matching ServerChatBox's warn-selected channel
	const accent = 'border-orange-500/60 focus-visible:ring-orange-500/50'
	const resolvedPlaceholder = warnDenied ? 'Missing permission' : noTargets ? 'No one to warn' : placeholder ?? 'Warn…'

	return (
		<div className={cn('flex flex-col gap-1', className)}>
			{username && (
				<label
					className="flex items-center self-end gap-1 text-xs text-muted-foreground whitespace-nowrap cursor-pointer"
					title="Prefix the message with your username"
				>
					<Checkbox checked={prefixName} onCheckedChange={(checked: boolean) => setPrefixName(checked)} className="h-3.5 w-3.5" />
					{username}:
				</label>
			)}
			<div className="flex items-stretch gap-1.5">
				<Textarea
					ref={textareaRef}
					value={message}
					onChange={e => setMessage(e.target.value)}
					onKeyDown={e => {
						if (e.key === 'Enter' && !e.shiftKey) {
							e.preventDefault()
							void send()
						}
					}}
					placeholder={resolvedPlaceholder}
					disabled={!!warnDenied}
					rows={2}
					className={cn('min-h-0 h-auto text-xs flex-1 min-w-0 resize-none px-2 py-1', accent)}
				/>
				<Button
					size="sm"
					variant="outline"
					className={cn('h-auto self-stretch w-7 p-0 shrink-0 text-orange-400', accent)}
					onClick={() => void send()}
					disabled={sendDisabled}
					title="Send warning (Enter)"
				>
					{pending ? <Icons.Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icons.Send className="h-3.5 w-3.5" />}
				</Button>
			</div>
		</div>
	)
}
