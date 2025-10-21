import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/hooks/use-toast'
import * as UsersClient from '@/systems.client/users.client'
import { invalidateLoggedInUser, useLoggedInUser } from '@/systems.client/users.client'
import { trpc } from '@/trpc.client'
import * as Icons from 'lucide-react'
import React from 'react'

export default function NicknameDialog(
	props: { children: React.ReactNode; open?: boolean; onOpenChange?: (newState: boolean) => void },
) {
	const user = useLoggedInUser()
	const [nickname, setNickname] = React.useState('')
	const [isLoading, setIsLoading] = React.useState(false)
	const { toast } = useToast()

	// Update local state when user data changes or dialog opens
	React.useEffect(() => {
		if (props.open && user) {
			setNickname(user.nickname || '')
		}
	}, [props.open, user])

	const handleSave = async () => {
		if (!user) return

		setIsLoading(true)
		try {
			const result = await trpc.users.updateNickname.mutate(nickname.trim() || undefined)
			if (result.code === 'ok') {
				UsersClient.invalidateLoggedInUser()
				toast({
					title: 'Nickname updated successfully!',
				})
				invalidateLoggedInUser()
				props.onOpenChange?.(false)
			} else {
				toast({
					title: 'Error updating nickname',
					description: result.msg,
					variant: 'destructive',
				})
			}
		} catch (error) {
			toast({
				title: 'Failed to update nickname',
				description: 'An unexpected error occurred',
				variant: 'destructive',
			})
			console.error('Error updating nickname:', error)
		} finally {
			setIsLoading(false)
		}
	}

	const handleCancel = () => {
		setNickname(user?.nickname || '')
		props.onOpenChange?.(false)
	}

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault()
			handleSave()
		}
		if (e.key === 'Escape') {
			handleCancel()
		}
	}

	const isChanged = (nickname.trim() || null) !== (user?.nickname || null)
	const isValid = nickname.length <= 64

	return (
		<Dialog modal={true} open={props.open} onOpenChange={props.onOpenChange}>
			<DialogTrigger asChild={true}>
				{props.children}
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Set Custom Nickname</DialogTitle>
					<DialogDescription>
						Choose a custom nickname that will be displayed instead of your Discord name. Leave empty to use your Discord display name.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="nickname">Nickname</Label>
						<Input
							id="nickname"
							value={nickname}
							onChange={(e) => setNickname(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder="Enter a custom nickname..."
							maxLength={64}
							disabled={isLoading}
						/>
						<div className="flex justify-between text-xs text-muted-foreground">
							<span>
								{nickname ? `Will display as: "${nickname.trim() || user?.username}"` : 'Will use Discord display name'}
							</span>
							<span className={nickname.length > 64 ? 'text-destructive' : ''}>
								{nickname.length}/64
							</span>
						</div>
					</div>

					{!isValid && (
						<div className="text-sm text-destructive">
							Nickname must be 64 characters or less
						</div>
					)}
				</div>

				<DialogFooter className="flex flex-col sm:flex-row gap-2">
					<Button variant="outline" onClick={handleCancel} disabled={isLoading}>
						Cancel
					</Button>
					<Button
						onClick={handleSave}
						disabled={!isChanged || !isValid || isLoading}
					>
						{isLoading && <Icons.Loader2 className="mr-2 h-4 w-4 animate-spin" />}
						{isLoading ? 'Saving...' : 'Save'}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
