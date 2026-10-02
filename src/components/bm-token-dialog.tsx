import * as Icons from 'lucide-react'
import React from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from '@/lib/toast'
import * as BM_Msgs from '@/messages/battlemetrics.messages'
import * as UI_Msgs from '@/messages/ui.messages'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import { tr } from '@/systems/messages.client'
import * as UsersClient from '@/systems/users.client'

const BM_DEVELOPERS_URL = 'https://www.battlemetrics.com/developers'

export default function BmTokenDialog(props: {
	children: React.ReactNode
	open?: boolean
	onOpenChange?: (newState: boolean) => void
	onLinkSteam: () => void
}) {
	return (
		<Dialog modal open={props.open} onOpenChange={props.onOpenChange}>
			<DialogTrigger asChild>{props.children}</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				{/* DialogContent unmounts on close, so every open starts on the form with an empty field */}
				<BmTokenDialogBody onClose={() => props.onOpenChange?.(false)} onLinkSteam={props.onLinkSteam} />
			</DialogContent>
		</Dialog>
	)
}

function BmTokenDialogBody(props: { onClose: () => void; onLinkSteam: () => void }) {
	const [step, setStep] = React.useState<'form' | 'link-steam'>('form')
	if (step === 'link-steam') return <LinkSteamPrompt onClose={props.onClose} onLinkSteam={props.onLinkSteam} />
	return <TokenForm onClose={props.onClose} onSaved={() => setStep('link-steam')} />
}

function TokenForm(props: { onClose: () => void; onSaved: () => void }) {
	const tokenQuery = BattlemetricsClient.useMyToken()
	const linkedQuery = UsersClient.useMyLinkedSteamAccounts()
	const setMutation = BattlemetricsClient.useSetMyTokenMutation()
	const removeMutation = BattlemetricsClient.useRemoveMyTokenMutation()
	const inputRef = React.useRef<HTMLInputElement>(null)
	const [hasInput, setHasInput] = React.useState(false)

	const updatedAt = tokenQuery.data?.code === 'ok' ? tokenQuery.data.updatedAt : null
	const pending = setMutation.isPending || removeMutation.isPending
	const result = setMutation.data

	const save = async () => {
		const token = inputRef.current?.value.trim()
		if (!token) return
		const res = await setMutation.mutateAsync({ token })
		if (res.code !== 'ok') return
		toast(...tr.toast(BM_Msgs.tokenSavedToast()))
		const hasSteamLink = linkedQuery.data?.code === 'ok' && linkedQuery.data.links.length > 0
		if (hasSteamLink) props.onClose()
		else props.onSaved()
	}

	const remove = async () => {
		try {
			await removeMutation.mutateAsync(undefined)
			toast(...tr.toast(BM_Msgs.tokenRemovedToast()))
			props.onClose()
		} catch (err) {
			console.error('Error removing BattleMetrics token:', err)
			toast.error(...tr.toast(BM_Msgs.tokenRemoveFailed()))
		}
	}

	return (
		<>
			<DialogHeader>
				<DialogTitle>{tr.text(BM_Msgs.tokenDialogTitle())}</DialogTitle>
				<DialogDescription>{tr.text(BM_Msgs.tokenDialogBlurb())}</DialogDescription>
			</DialogHeader>

			<div className="space-y-4 text-sm">
				<div className="space-y-2">
					<a
						href={BM_DEVELOPERS_URL}
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-primary"
					>
						{tr.text(BM_Msgs.tokenCreateLink())}
						<Icons.ExternalLink className="h-3.5 w-3.5" />
					</a>
					<p>{tr.text(BM_Msgs.tokenScopesHeading())}</p>
					<ul className="list-disc ps-5 text-muted-foreground">
						<li>{tr.text(BM_Msgs.tokenScopeFlags())}</li>
						<li>{tr.text(BM_Msgs.tokenScopeNotes())}</li>
					</ul>
				</div>

				<p className="text-muted-foreground">
					{updatedAt !== null ? tr.text(BM_Msgs.tokenSaved(new Date(updatedAt).toLocaleString())) : tr.text(BM_Msgs.tokenNotSaved())}
				</p>

				<div className="space-y-2">
					<Label htmlFor="bm-token">{tr.text(BM_Msgs.tokenFieldLabel())}</Label>
					<Input
						id="bm-token"
						ref={inputRef}
						type="password"
						autoComplete="off"
						onInput={(e) => setHasInput(e.currentTarget.value.trim() !== '')}
						onKeyDown={(e) => {
							if (e.key !== 'Enter') return
							e.preventDefault()
							void save()
						}}
						placeholder={tr.text(updatedAt !== null ? BM_Msgs.tokenFieldReplacePlaceholder() : BM_Msgs.tokenFieldPlaceholder())}
						disabled={pending}
					/>
					{result?.code === 'err:token-rejected' && <p className="text-destructive">{tr.text(BM_Msgs.tokenRejected())}</p>}
					{result?.code === 'err:check-failed' && <p className="text-destructive">{tr.text(BM_Msgs.tokenCheckFailed())}</p>}
				</div>
			</div>

			<DialogFooter className="flex flex-col gap-2 sm:flex-row">
				{updatedAt !== null && (
					<Button variant="outline" className="sm:me-auto" onClick={remove} disabled={pending}>
						{tr.text(BM_Msgs.tokenRemove())}
					</Button>
				)}
				<Button variant="outline" onClick={props.onClose} disabled={pending}>
					{tr.text(UI_Msgs.cancel())}
				</Button>
				<Button onClick={save} disabled={!hasInput || pending}>
					{setMutation.isPending && <Icons.Loader2 className="me-2 h-4 w-4 animate-spin" />}
					{tr.text(BM_Msgs.tokenSave())}
				</Button>
			</DialogFooter>
		</>
	)
}

function LinkSteamPrompt(props: { onClose: () => void; onLinkSteam: () => void }) {
	return (
		<>
			<DialogHeader>
				<DialogTitle>{tr.text(BM_Msgs.tokenLinkSteamHeading())}</DialogTitle>
				<DialogDescription>{tr.text(BM_Msgs.tokenLinkSteamBlurb())}</DialogDescription>
			</DialogHeader>
			<DialogFooter className="flex flex-col gap-2 sm:flex-row">
				<Button variant="outline" onClick={props.onClose}>
					{tr.text(BM_Msgs.tokenLinkSteamLater())}
				</Button>
				<Button onClick={props.onLinkSteam}>
					<Icons.Link className="me-2 h-4 w-4" />
					{tr.text(BM_Msgs.tokenLinkSteamAction())}
				</Button>
			</DialogFooter>
		</>
	)
}
