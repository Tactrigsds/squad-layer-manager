import * as Icons from 'lucide-react'
import React from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { toast } from '@/lib/toast'
import * as Zus from '@/lib/zustand'
import * as UI_Msgs from '@/messages/ui.messages'
import * as USR_Msgs from '@/messages/users.messages'
import * as CMD from '@/models/command.models'
import type * as USR from '@/models/users.models'
import { tr } from '@/systems/messages.client'
import * as SettingsClient from '@/systems/settings.client'
import * as UsersClient from '@/systems/users.client'

export default function LinkSteamAccountDialog(props: {
	children: React.ReactNode
	open?: boolean
	onOpenChange?: (newState: boolean) => void
}) {
	const linkedQuery = UsersClient.useMyLinkedSteamAccounts()
	return (
		<Dialog modal open={props.open} onOpenChange={props.onOpenChange}>
			<DialogTrigger asChild>{props.children}</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{tr.text(USR_Msgs.steamDialogTitle())}</DialogTitle>
					<DialogDescription>{tr.text(USR_Msgs.steamDialogBlurb())}</DialogDescription>
				</DialogHeader>
				{linkedQuery.data?.code === 'ok' ? (
					<LinkedSteamAccountsEditor links={linkedQuery.data.links} onClose={() => props.onOpenChange?.(false)} />
				) : (
					<p className="text-sm text-muted-foreground">{tr.text(UI_Msgs.loadingEllipsis())}</p>
				)}
			</DialogContent>
		</Dialog>
	)
}

function formatRemaining(ms: number): string {
	const total = Math.max(0, Math.ceil(ms / 1000))
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function LinkedSteamAccountsEditor({ links, onClose }: { links: readonly USR.SteamAccountLink[]; onClose: () => void }) {
	const updateMutation = UsersClient.useUpdateLinkedSteamAccountsMutation()
	const beginMutation = UsersClient.useBeginSteamLinkVerificationMutation()
	// the trigger as this installation actually spells it, so a renamed command or a different prefix is what we show
	const command = Zus.useStore(SettingsClient.PublicSettingsStore, (settings) => {
		const config = settings?.commands.linkSteamAccount
		if (!config?.enabled) return null
		const primary = CMD.primaryTrigger(config)
		return primary ? CMD.triggerString(primary) : null
	})

	// `linkCount` is what tells us the code was used: the game never answers the browser, but the link landing
	// invalidates this query, so the list growing is the confirmation
	const [session, setSession] = React.useState<{ code: string; expiresAt: number; linkCount: number } | null>(null)
	const [now, setNow] = React.useState(() => Date.now())
	const landed = session !== null && links.length > session.linkCount
	const expired = session !== null && now >= session.expiresAt
	const awaiting = session !== null && !landed && !expired

	React.useEffect(() => {
		if (!awaiting) return
		const handle = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(handle)
	}, [awaiting])

	async function handleBegin() {
		const res = await beginMutation.mutateAsync({})
		if (res.code !== 'ok') {
			toast.error(...tr.toast(USR_Msgs.linkCodeMintFailed()))
			return
		}
		setNow(Date.now())
		setSession({ code: res.verificationCode, expiresAt: res.expiresAt, linkCount: links.length })
	}

	async function handleRemove(steamId: string) {
		const res = await updateMutation.mutateAsync(links.filter((link) => link.steamId !== steamId).map((link) => link.steamId))
		if (res.code === 'ok') toast(...tr.toast(USR_Msgs.steamAccountsUpdated()))
		else toast.error(...tr.toast(USR_Msgs.steamLinkFailed()))
	}

	const pending = updateMutation.isPending || beginMutation.isPending

	return (
		<>
			<div className="space-y-1.5">
				{links.map((link) => (
					<div key={link.steamId} className="flex items-center gap-2 rounded-md border border-border/60 bg-card px-3 py-2">
						<div className="min-w-0 flex-1">
							<div className="font-mono text-sm">{link.steamId}</div>
							<div className="text-xs text-muted-foreground">
								{link.origin === 'assigned'
									? tr.text(USR_Msgs.steamLinkedByAdmin(link.linkedBy?.displayName ?? 'an admin'))
									: tr.text(USR_Msgs.selfLinked())}
							</div>
						</div>
						<Button
							type="button"
							size="icon"
							variant="ghost"
							className="h-8 w-8 shrink-0 text-destructive"
							disabled={pending}
							onClick={() => void handleRemove(link.steamId)}
						>
							<Icons.X className="h-4 w-4" />
						</Button>
					</div>
				))}
			</div>

			{command !== null && (
				<div>
					{awaiting ? (
						<CodePanel command={command} code={session.code} remaining={session.expiresAt - now} onCancel={() => setSession(null)} />
					) : (
						<Button
							type="button"
							variant="outline"
							className="w-full border-dashed"
							disabled={pending}
							onClick={() => void handleBegin()}
						>
							{expired ? <Icons.RotateCcw className="mr-2 h-4 w-4" /> : <Icons.Plus className="mr-2 h-4 w-4" />}
							{expired ? tr.text(USR_Msgs.linkCodeRetry()) : tr.text(USR_Msgs.linkAccountAction())}
						</Button>
					)}
					{expired && <p className="mt-1.5 text-xs text-muted-foreground">{tr.text(USR_Msgs.linkCodeExpired())}</p>}
				</div>
			)}

			<DialogFooter>
				<Button variant="outline" onClick={onClose}>
					{tr.text(UI_Msgs.close())}
				</Button>
			</DialogFooter>
		</>
	)
}

function CodePanel({ command, code, remaining, onCancel }: { command: string; code: string; remaining: number; onCancel: () => void }) {
	const [copied, setCopied] = React.useState(false)
	const timeoutRef = React.useRef<ReturnType<typeof setTimeout>>(null)
	const line = `${command} ${code}`

	React.useEffect(
		() => () => {
			if (timeoutRef.current) clearTimeout(timeoutRef.current)
		},
		[],
	)

	function handleCopy() {
		void navigator.clipboard.writeText(line)
		setCopied(true)
		if (timeoutRef.current) clearTimeout(timeoutRef.current)
		timeoutRef.current = setTimeout(() => setCopied(false), 1500)
	}

	return (
		<div className="rounded-md border border-border bg-background/60 px-3 py-3">
			<div className="text-[11px] uppercase tracking-wide text-muted-foreground">{tr.text(USR_Msgs.linkCodeSendLabel())}</div>
			<div className="mt-2 flex items-center gap-2">
				<span className="min-w-0 flex-1 break-all font-mono text-lg font-semibold tracking-wide">{line}</span>
				<Button type="button" size="sm" variant="outline" className="shrink-0" onClick={handleCopy}>
					{copied ? <Icons.Check className="mr-1.5 h-3.5 w-3.5" /> : <Icons.Copy className="mr-1.5 h-3.5 w-3.5" />}
					{tr.text(USR_Msgs.linkCodeCopy())}
				</Button>
			</div>
			<div className="mt-2.5 flex items-center gap-2 text-xs text-muted-foreground">
				<Icons.Loader2 className="h-3.5 w-3.5 animate-spin" />
				{tr.text(USR_Msgs.linkCodeWaiting())}
			</div>
			<div className="mt-2 flex items-center justify-between">
				<span className="text-xs text-muted-foreground">{tr.text(USR_Msgs.linkCodeExpiresIn(formatRemaining(remaining)))}</span>
				<Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onCancel}>
					{tr.text(UI_Msgs.cancel())}
				</Button>
			</div>
		</div>
	)
}
