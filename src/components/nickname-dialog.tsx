import { useMutation } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from '@/lib/toast'
import * as UI_Msgs from '@/messages/ui.messages'
import * as USR_Msgs from '@/messages/users.messages'
import * as RPC from '@/orpc.client'
import * as UsersClient from '@/systems/users.client'
import { invalidateLoggedInUser, useLoggedInUser } from '@/systems/users.client'

export default function NicknameDialog(props: { children: React.ReactNode; open?: boolean; onOpenChange?: (newState: boolean) => void }) {
	const user = useLoggedInUser()
	const [nickname, setNickname] = React.useState('')
	const updateNicknameMutation = useMutation(
		RPC.orpc.users.updateNickname.mutationOptions({
			onSuccess: (result) => {
				if (result.code === 'ok') {
					UsersClient.invalidateLoggedInUser()
					toast(...USR_Msgs.nicknameUpdated().toast())
					invalidateLoggedInUser()
					props.onOpenChange?.(false)
				} else {
					toast.error(...USR_Msgs.nicknameRejected(result.msg).toast())
				}
			},
			onError: (error) => {
				toast.error(...USR_Msgs.nicknameUpdateFailed().toast())
				console.error('Error updating nickname:', error)
			},
		}),
	)

	// Update local state when user data changes or dialog opens
	React.useEffect(() => {
		if (props.open && user) {
			setNickname(user.nickname || '')
		}
	}, [props.open, user])

	const handleSave = async () => {
		if (!user) return
		await updateNicknameMutation.mutateAsync(nickname.trim() || undefined)
	}

	const handleCancel = () => {
		setNickname(user?.nickname || '')
		props.onOpenChange?.(false)
	}

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault()
			void handleSave()
		}
		if (e.key === 'Escape') {
			handleCancel()
		}
	}

	const isChanged = (nickname.trim() || null) !== (user?.nickname || null)
	const isValid = nickname.length <= 64

	return (
		<Dialog modal open={props.open} onOpenChange={props.onOpenChange}>
			<DialogTrigger asChild>{props.children}</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{USR_Msgs.nicknameDialogTitle().text()}</DialogTitle>
					<DialogDescription>{USR_Msgs.nicknameDialogBlurb().text()}</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="nickname">{USR_Msgs.nicknameFieldLabel().text()}</Label>
						<Input
							id="nickname"
							value={nickname}
							onChange={(e) => setNickname(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder={USR_Msgs.nicknamePlaceholder().text()}
							maxLength={64}
							disabled={updateNicknameMutation.isPending}
						/>
						<div className="flex justify-between text-xs text-muted-foreground">
							<span>
								{nickname
									? USR_Msgs.nicknamePreview(nickname.trim() || (user?.username ?? '')).text()
									: USR_Msgs.nicknameFallsBackToDiscord().text()}
							</span>
							<span className={nickname.length > 64 ? 'text-destructive' : ''}>{nickname.length}/64</span>
						</div>
					</div>

					{!isValid && <div className="text-sm text-destructive">{USR_Msgs.nicknameTooLong().text()}</div>}
				</div>

				<DialogFooter className="flex flex-col sm:flex-row gap-2">
					<Button variant="outline" onClick={handleCancel} disabled={updateNicknameMutation.isPending}>
						{UI_Msgs.cancel().text()}
					</Button>
					<Button onClick={handleSave} disabled={!isChanged || !isValid || updateNicknameMutation.isPending}>
						{updateNicknameMutation.isPending && <Icons.Loader2 className="mr-2 h-4 w-4 animate-spin" />}
						{updateNicknameMutation.isPending ? USR_Msgs.saving().text() : USR_Msgs.save().text()}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
