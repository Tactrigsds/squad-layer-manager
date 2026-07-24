import { AdminReasonPicker } from '@/components/admin-reason-picker'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import * as ZusUtils from '@/lib/zustand'
import * as RBAC from '@/rbac.models'
import * as RbacClient from '@/systems/rbac.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as UsersClient from '@/systems/users.client'
import * as WarnChat from '@/systems/warn-chat.client'
import * as Icons from 'lucide-react'
import React from 'react'

type Channel = 'warn-admins' | 'broadcast' | 'warn-selected'

// broadcast matches CHANNEL_STYLES.Broadcast in server-event.tsx (yellow-500); warn-selected gets orange as a
// "targeted warn" accent distinct from both
const CHANNEL_CFG: Record<Channel, {
	icon: React.ComponentType<{ className?: string }>
	triggerClass: string
	inputClass: string
}> = {
	'warn-admins': {
		icon: Icons.Shield,
		triggerClass: 'border-admin/60 text-admin focus:ring-admin/50 [&_svg]:text-admin',
		inputClass: 'border-admin/60 focus-visible:ring-admin/50',
	},
	broadcast: {
		icon: Icons.Megaphone,
		triggerClass: 'border-yellow-500/60 text-yellow-500 focus:ring-yellow-500/50 [&_svg]:text-yellow-500',
		inputClass: 'border-yellow-500/60 focus-visible:ring-yellow-500/50',
	},
	'warn-selected': {
		icon: Icons.AlertTriangle,
		triggerClass: 'border-orange-500/60 text-orange-400 focus:ring-orange-500/50 [&_svg]:text-orange-400',
		inputClass: 'border-orange-500/60 focus-visible:ring-orange-500/50',
	},
}

export default function ServerChatBox({ stores }: { stores: SquadServerFrame.KeyProp }) {
	const serverId = stores.squadServer.serverId
	const initialChannel: Channel = SquadServerFrame.Sel.hasSelection(ZusUtils.getState(stores.squadServer))
		? 'warn-selected'
		: 'warn-admins'
	const [channel, setChannel] = React.useState<Channel>(initialChannel)
	const [message, setMessage] = React.useState('')
	// warning admins prefixes the sender's name by default so they know who warned them; other channels default off
	const [prefixName, setPrefixName] = React.useState(() => initialChannel === 'warn-admins')
	// null follows the server's admin-target rule; set once the admin ticks the box either way
	const [notifyAdmins, setNotifyAdmins] = React.useState<boolean | null>(null)
	const textareaRef = React.useRef<HTMLTextAreaElement>(null)

	// switch channel and reset the name-prefix and notify-admins toggles to that channel's defaults
	function selectChannel(next: Channel) {
		setChannel(next)
		setPrefixName(next === 'warn-admins')
		setNotifyAdmins(null)
	}

	// a "warn selected" menu action routes here: force the selected channel (overriding even broadcast, since
	// this is an explicit warn) and focus the box so the admin can type immediately
	WarnChat.useWarnFocusRequest(
		t => t.kind === 'server-activity',
		() => {
			selectChannel('warn-selected')
			WarnChat.focusWhenVisible(() => textareaRef.current)
		},
	)

	// follow the teams-panel selection: empty -> non-empty picks "Selected", the reverse falls back to "Admins".
	// broadcast is a deliberate choice, so leave it alone.
	React.useEffect(() =>
		ZusUtils.resolveReadStore(stores.squadServer).subscribe((state, prev) => {
			const now = SquadServerFrame.Sel.hasSelection(state)
			if (now === SquadServerFrame.Sel.hasSelection(prev)) return
			if (channel === 'broadcast') return
			selectChannel(now ? 'warn-selected' : 'warn-admins')
		}), [channel, stores.squadServer])

	const username = UsersClient.useLoggedInUser()?.displayName
	const warnDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:warn-players'))
	const broadcastDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:broadcast'))
	const selectedCount = ZusUtils.useStore(stores.squadServer, SquadServerFrame.Sel.selectedPlayerCount)
	const selectionIsAllAdmins = ZusUtils.useStore(stores.squadServer, SquadServerFrame.Sel.selectionIsAllAdmins)
	const notifyAdminsChecked = notifyAdmins ?? !selectionIsAllAdmins
	// broadcasts get the reasons' broadcast text, not their warn text
	const draft = WarnChat.useAdminReasonDraft(channel === 'broadcast' ? 'broadcast' : 'warn')

	const warnAdminsMutation = SquadServerClient.useWarnAdminsMutation()
	const broadcastMutation = SquadServerClient.useBroadcastMutation()
	const warnPlayersMutation = SquadServerClient.useWarnPlayersMutation()
	const pending = warnAdminsMutation.isPending || broadcastMutation.isPending || warnPlayersMutation.isPending

	const cfg = CHANNEL_CFG[channel]
	const channelDenied = channel === 'broadcast' ? broadcastDenied : warnDenied
	const sendDisabled = pending || !!channelDenied || !message.trim() || (channel === 'warn-selected' && selectedCount === 0)

	async function send() {
		const text = message.trim()
		if (!text || sendDisabled) return
		// the sender's name leads the whole message, ahead of any audience tag: "grey275: @admins ...". warn-selected
		// leaves both to the server, which is the only path that knows who the "@..." tag should name.
		const prefixed = (body: string) => prefixName && username ? `${username}: ${body}` : body
		const asPreset = draft.match(text)
		try {
			let res: { code: string }
			if (channel === 'warn-admins') {
				res = await warnAdminsMutation.mutateAsync({ serverId, message: prefixed(`@admins ${text}`) })
			} else if (channel === 'broadcast') {
				res = await broadcastMutation.mutateAsync({
					serverId,
					prefixSenderName: prefixName && !!username,
					...(asPreset ? { presetReasonLabel: asPreset.label } : { message: text }),
				})
			} else {
				const playerIds = [...SquadServerFrame.Sel.selectedPlayerIds(ZusUtils.getState(stores.squadServer))]
				if (playerIds.length === 0) return
				res = await warnPlayersMutation.mutateAsync({
					serverId,
					playerIds,
					notifyAdmins: notifyAdminsChecked,
					prefixSenderName: prefixName && !!username,
					...(asPreset ? { presetReasonLabel: asPreset.label } : { reason: text }),
				})
			}
			if (res.code !== 'ok') {
				toast.error('Failed to send', { description: res.code })
				return
			}
			setMessage('')
			draft.reset()
		} catch (e) {
			console.error(e)
			toast.error('Failed to send')
		}
	}

	const placeholder = channelDenied
		? 'Missing permission'
		: channel === 'warn-admins'
		? 'Warn all online admins…'
		: channel === 'broadcast'
		? 'Broadcast to the server…'
		: selectedCount === 0
		? 'No players selected in the teams panel'
		: `Warn ${selectedCount} selected ${selectedCount === 1 ? 'player' : 'players'}…`

	return (
		<div className="flex items-stretch gap-1.5 pt-1 shrink-0">
			<div className="flex flex-col justify-between gap-1 shrink-0">
				<div className="flex items-center self-end gap-2">
					{channel === 'warn-selected' && (
						<label
							className="flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap cursor-pointer"
							title="Warn every online admin that this warn was sent"
						>
							<Checkbox
								checked={notifyAdminsChecked}
								onCheckedChange={(checked: boolean) => setNotifyAdmins(checked)}
								className="h-3.5 w-3.5"
							/>
							Notify admins
						</label>
					)}
					{username && (
						<label
							className="flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap cursor-pointer"
							title="Prefix the message with your username"
						>
							<Checkbox checked={prefixName} onCheckedChange={(checked: boolean) => setPrefixName(checked)} className="h-3.5 w-3.5" />
							{username}:
						</label>
					)}
				</div>
				<Select value={channel} onValueChange={v => selectChannel(v as Channel)}>
					<SelectTrigger
						className={cn('h-7 w-auto min-w-[7rem] gap-1.5 px-2 text-xs shrink-0 [&>span]:whitespace-nowrap', cfg.triggerClass)}
					>
						<cfg.icon className="h-3.5 w-3.5 shrink-0" />
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="warn-admins" disabled={!!warnDenied} className="text-xs text-admin whitespace-nowrap">Admins</SelectItem>
						<SelectItem value="broadcast" disabled={!!broadcastDenied} className="text-xs text-yellow-500 whitespace-nowrap">
							Broadcast
						</SelectItem>
						<SelectItem value="warn-selected" disabled={!!warnDenied} className="text-xs text-orange-400 whitespace-nowrap">
							Selected{selectedCount > 0 ? ` (${selectedCount})` : ''}
						</SelectItem>
					</SelectContent>
				</Select>
			</div>
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
				placeholder={placeholder}
				disabled={!!channelDenied}
				rows={2}
				className={cn('min-h-0 h-auto text-xs flex-1 min-w-0 resize-none px-2 py-1', cfg.inputClass)}
			/>
			{/* warn-admins is a free-form message to admins, with no preset codepath behind it */}
			{channel !== 'warn-admins' && (
				<AdminReasonPicker
					reasons={draft.reasons}
					preview={draft.render}
					onPick={reason => {
						setMessage(draft.pick(reason))
						textareaRef.current?.focus()
					}}
					disabled={!!channelDenied}
					title={channel === 'broadcast' ? 'Fill the box with a preset broadcast' : 'Fill the box with a preset reason'}
					className={cfg.triggerClass}
				/>
			)}
			<Button
				size="sm"
				variant="outline"
				className={cn('h-auto self-stretch w-7 p-0 shrink-0', cfg.triggerClass)}
				onClick={() => void send()}
				disabled={sendDisabled}
				title="Send (Enter)"
			>
				{pending ? <Icons.Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icons.Send className="h-3.5 w-3.5" />}
			</Button>
		</div>
	)
}
