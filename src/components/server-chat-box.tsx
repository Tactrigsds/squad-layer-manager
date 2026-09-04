import * as Icons from 'lucide-react'
import React from 'react'

import { AdminReasonPicker } from '@/components/admin-reason-picker'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as AAR_Msgs from '@/messages/admin-action-reasons.messages'
import * as CHAT_Msgs from '@/messages/chat.messages'
import * as RBAC from '@/rbac.models'
import { tr } from '@/systems/messages.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as UsersClient from '@/systems/users.client'
import * as WarnChat from '@/systems/warn-chat.client'

type Channel = 'warn-admins' | 'broadcast' | 'warn-selected'

// broadcast matches CHANNEL_STYLES.Broadcast in server-event.tsx (yellow-500); warn-selected gets orange as a
// "targeted warn" accent distinct from both
const CHANNEL_CFG: Record<
	Channel,
	{
		icon: React.ComponentType<{ className?: string }>
		triggerClass: string
		inputClass: string
	}
> = {
	'warn-admins': {
		icon: Icons.Shield,
		triggerClass:
			'text-admin [&_svg]:text-admin shadow-[inset_0_1px_0_var(--ctl-hi),inset_0_-1px_0_var(--ctl-lo),inset_0_0_0_1px_rgba(140,192,255,0.5)]',
		inputClass: 'shadow-[inset_0_1px_2px_rgba(0,0,0,0.7),inset_0_0_0_1px_rgba(140,192,255,0.5)]',
	},
	broadcast: {
		icon: Icons.Megaphone,
		triggerClass:
			'text-warn [&_svg]:text-warn shadow-[inset_0_1px_0_var(--ctl-hi),inset_0_-1px_0_var(--ctl-lo),inset_0_0_0_1px_rgba(232,194,74,0.5)]',
		inputClass: 'shadow-[inset_0_1px_2px_rgba(0,0,0,0.7),inset_0_0_0_1px_rgba(232,194,74,0.5)]',
	},
	'warn-selected': {
		icon: Icons.AlertTriangle,
		triggerClass:
			'text-pri-hi [&_svg]:text-pri-hi shadow-[inset_0_1px_0_var(--ctl-hi),inset_0_-1px_0_var(--ctl-lo),inset_0_0_0_1px_rgba(224,152,58,0.5)]',
		inputClass: 'shadow-[inset_0_1px_2px_rgba(0,0,0,0.7),inset_0_0_0_1px_rgba(224,152,58,0.5)]',
	},
}

export default function ServerChatBox({ stores }: { stores: SquadServerFrame.KeyProp }) {
	const serverId = stores.squadServer.serverId
	const initialChannel: Channel = SquadServerFrame.Sel.hasSelection(Zus.getState(stores.squadServer)) ? 'warn-selected' : 'warn-admins'
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
		(t) => t.kind === 'server-activity',
		() => {
			selectChannel('warn-selected')
			WarnChat.focusWhenVisible(() => textareaRef.current)
		},
	)

	// follow the teams-panel selection: empty -> non-empty picks "Selected", the reverse falls back to "Admins".
	// broadcast is a deliberate choice, so leave it alone.
	React.useEffect(
		() =>
			Zus.resolveReadStore(stores.squadServer).subscribe((state, prev) => {
				const now = SquadServerFrame.Sel.hasSelection(state)
				if (now === SquadServerFrame.Sel.hasSelection(prev)) return
				if (channel === 'broadcast') return
				selectChannel(now ? 'warn-selected' : 'warn-admins')
			}),
		[channel, stores.squadServer],
	)

	const username = UsersClient.useLoggedInUser()?.displayName
	const warnDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:warn-players', { serverId: serverId }))
	const broadcastDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:broadcast', { serverId: serverId }))
	const selectedCount = Zus.useStore(stores.squadServer, SquadServerFrame.Sel.selectedPlayerCount)
	const selectionIsAllAdmins = Zus.useStore(stores.squadServer, SquadServerFrame.Sel.selectionIsAllAdmins)
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
		const prefixed = (body: string) => (prefixName && username ? `${username}: ${body}` : body)
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
				const playerIds = [...SquadServerFrame.Sel.selectedPlayerIds(Zus.getState(stores.squadServer))]
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
				toast.error(...tr.toast(CHAT_Msgs.sendFailed(res.code)))
				return
			}
			setMessage('')
			draft.reset()
		} catch (e) {
			console.error(e)
			toast.error(...tr.toast(CHAT_Msgs.sendFailed()))
		}
	}

	const placeholder = channelDenied
		? tr.text(CHAT_Msgs.missingPermission())
		: channel === 'warn-admins'
			? tr.text(CHAT_Msgs.warnAdminsPlaceholder())
			: channel === 'broadcast'
				? tr.text(CHAT_Msgs.broadcastPlaceholder())
				: selectedCount === 0
					? tr.text(CHAT_Msgs.nobodySelectedPlaceholder())
					: tr.text(CHAT_Msgs.warnSelectedPlaceholder(selectedCount))

	return (
		<div className="flex items-stretch gap-1.5 pt-1.5 shrink-0">
			<div className="flex flex-col justify-between gap-1 shrink-0 items-end">
				<div className="flex items-center gap-2">
					{channel === 'warn-selected' && (
						<label
							className="flex items-center gap-1 text-xs text-text-3 whitespace-nowrap cursor-pointer"
							title={tr.text(CHAT_Msgs.notifyAdminsHint())}
						>
							<Checkbox checked={notifyAdminsChecked} onCheckedChange={(checked: boolean) => setNotifyAdmins(checked)} />
							{tr.text(CHAT_Msgs.notifyAdmins())}
						</label>
					)}
					{username && (
						<label
							className="flex items-center gap-1 text-xs text-text-3 whitespace-nowrap cursor-pointer"
							title={tr.text(CHAT_Msgs.prefixNameHint())}
						>
							<Checkbox checked={prefixName} onCheckedChange={(checked: boolean) => setPrefixName(checked)} />
							{username}:
						</label>
					)}
				</div>
				<Select value={channel} onValueChange={(v) => selectChannel(v as Channel)}>
					<SelectTrigger
						className={cn(
							'fd-btn fd-btn-sm w-auto min-w-24 gap-1.5 px-2 bg-ctl shrink-0 [&>span]:whitespace-nowrap [&>span]:overflow-visible',
							cfg.triggerClass,
						)}
					>
						<cfg.icon className="size-3 shrink-0" />
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="warn-admins" disabled={!!warnDenied} className="text-admin whitespace-nowrap">
							{tr.text(CHAT_Msgs.warnAdminsChannel())}
						</SelectItem>
						<SelectItem value="broadcast" disabled={!!broadcastDenied} className="text-warn whitespace-nowrap">
							{tr.text(CHAT_Msgs.broadcastChannel())}
						</SelectItem>
						<SelectItem value="warn-selected" disabled={!!warnDenied} className="text-pri-hi whitespace-nowrap">
							{tr.text(CHAT_Msgs.warnSelectedChannel(selectedCount))}
						</SelectItem>
					</SelectContent>
				</Select>
			</div>
			<Textarea
				ref={textareaRef}
				value={message}
				onChange={(e) => setMessage(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter' && !e.shiftKey) {
						e.preventDefault()
						void send()
					}
				}}
				placeholder={placeholder}
				disabled={!!channelDenied}
				rows={2}
				className={cn('min-h-[38px] h-auto flex-1 min-w-0 resize-none px-2 py-1', cfg.inputClass)}
			/>
			{/* warn-admins is a free-form message to admins, with no preset codepath behind it */}
			{channel !== 'warn-admins' && (
				<AdminReasonPicker
					reasons={draft.reasons}
					preview={draft.render}
					onPick={(reason) => {
						setMessage(draft.pick(reason))
						textareaRef.current?.focus()
					}}
					disabled={!!channelDenied}
					title={channel === 'broadcast' ? tr.text(AAR_Msgs.fillWithPresetBroadcast()) : tr.text(AAR_Msgs.fillWithPresetReason())}
					className={cfg.triggerClass}
				/>
			)}
			<Button
				size="icon-sm"
				className="h-auto self-stretch shrink-0"
				onClick={() => void send()}
				disabled={sendDisabled}
				title={tr.text(CHAT_Msgs.sendHint())}
			>
				{pending ? <span className="fd-spin" /> : <Icons.Send />}
			</Button>
		</div>
	)
}
