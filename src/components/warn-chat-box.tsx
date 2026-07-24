import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import * as ZusUtils from '@/lib/zustand'
import * as AAR from '@/models/admin-action-reasons.models'
import type * as SM from '@/models/squad.models'
import * as RBAC from '@/rbac.models'
import * as RbacClient from '@/systems/rbac.client'
import * as SettingsClient from '@/systems/settings.client'
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

// Compact warn-chat input reused by the player- and squad-details windows so admins can warn a target straight
// from its window. The leading "@..." tag naming the audience is the server's job; `taggedSquad` tells it these
// targets are a squad rather than a set of players it should name individually.
export default function WarnChatBox({
	serverId,
	playerIds,
	taggedSquad,
	placeholder,
	focusTarget,
	className,
	stores,
}: {
	serverId: string
	playerIds: string[]
	taggedSquad?: { squadId: number; squadName: string; teamId: SM.TeamId }
	placeholder?: string
	focusTarget?: WarnChat.WarnFocusTarget
	className?: string
	stores: SquadServerFrame.KeyProp
}) {
	const [message, setMessage] = React.useState('')
	const [prefixName, setPrefixName] = React.useState(false)
	// null follows the server's admin-target rule; set once the admin ticks the box either way
	const [notifyAdmins, setNotifyAdmins] = React.useState<boolean | null>(null)
	// the preset last dropped into the box. Kept until send, which re-checks the text still matches it verbatim.
	const [presetLabel, setPresetLabel] = React.useState<string | null>(null)
	const [presetsOpen, setPresetsOpen] = React.useState(false)
	const textareaRef = React.useRef<HTMLTextAreaElement>(null)

	WarnChat.useWarnFocusRequest(
		t => !!focusTarget && warnTargetsEqual(t, focusTarget),
		() => WarnChat.focusWhenVisible(() => textareaRef.current),
	)
	const username = UsersClient.useLoggedInUser()?.displayName
	const warnDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:warn-players'))
	const warnPlayersMutation = SquadServerClient.useWarnPlayersMutation()
	const pending = warnPlayersMutation.isPending
	const targetsAreAllAdmins = ZusUtils.useStore(stores.squadServer, SquadServerFrame.Sel.allTargetsAreAdmins(playerIds))
	const notifyAdminsChecked = notifyAdmins ?? !targetsAreAllAdmins
	const reasons = ZusUtils.useStore(
		SettingsClient.PublicSettingsStore,
		s => s ? AAR.reasonsForAction(s.adminActionReasons, 'warn') : [],
	)
	const messageVars = ZusUtils.useStore(
		SettingsClient.PublicSettingsStore,
		s => Object.fromEntries((s?.messageVariables ?? []).map(v => [v.name, v.value])) as Record<string, string>,
	)
	// untagged: the server prepends the "@..." audience tag to whatever it's given, on both paths
	const renderPreset = (reason: AAR.AdminActionReason) => AAR.formatAppliedReason('warn', reason, { vars: messageVars }).trim()

	const noTargets = playerIds.length === 0
	const sendDisabled = pending || !!warnDenied || noTargets || !message.trim()

	function applyPreset(reason: AAR.AdminActionReason) {
		setMessage(renderPreset(reason))
		setPresetLabel(reason.label)
		textareaRef.current?.focus()
	}

	async function send() {
		const text = message.trim()
		if (!text || sendDisabled) return
		const composed = prefixName && username ? `${username}: ${text}` : text
		// route through the admin-action-reason path only when the server would render exactly what's in the box:
		// the text is still the preset verbatim, and there's no username prefix for that path to drop
		const preset = reasons.find(r => r.label === presetLabel)
		const asPreset = preset && text === renderPreset(preset) && !(prefixName && username) ? preset : undefined
		try {
			const res = await warnPlayersMutation.mutateAsync({
				serverId,
				playerIds,
				taggedSquad,
				notifyAdmins: notifyAdminsChecked,
				...(asPreset ? { presetReasonLabel: asPreset.label } : { reason: composed }),
			})
			if (res.code !== 'ok') {
				toast.error('Failed to send', { description: res.code })
				return
			}
			setMessage('')
			setPresetLabel(null)
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
			<div className="flex items-center self-end gap-2">
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
				{reasons.length > 0 && (
					<Popover open={presetsOpen} onOpenChange={setPresetsOpen}>
						<PopoverTrigger asChild>
							<Button
								size="sm"
								variant="outline"
								className={cn('h-auto self-stretch w-7 p-0 shrink-0 text-orange-400', accent)}
								disabled={!!warnDenied}
								title="Fill the box with a preset reason"
								aria-label="Preset reason"
							>
								<Icons.ListPlus className="h-3.5 w-3.5" />
							</Button>
						</PopoverTrigger>
						<PopoverContent align="end" className="w-56 p-0">
							<Command>
								<CommandInput placeholder="Search reasons..." />
								<CommandList>
									<CommandEmpty>No reasons found.</CommandEmpty>
									<CommandGroup>
										{reasons.map(reason => (
											<CommandItem
												key={reason.label}
												value={reason.label}
												keywords={reason.aliases}
												onSelect={() => {
													applyPreset(reason)
													setPresetsOpen(false)
												}}
											>
												<span className="flex flex-col gap-0.5 min-w-0">
													<span>{reason.label}</span>
													<span className="text-xs text-muted-foreground truncate">{renderPreset(reason)}</span>
												</span>
											</CommandItem>
										))}
									</CommandGroup>
								</CommandList>
							</Command>
						</PopoverContent>
					</Popover>
				)}
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
