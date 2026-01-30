import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { globalToast$ } from '@/hooks/use-global-toast.ts'
import { useToast } from '@/hooks/use-toast'
import { assertNever } from '@/lib/type-guards.ts'
import * as RPC from '@/orpc.client.ts'
import * as RBAC from '@/rbac.models'
import * as QD from '@/systems/queue-dashboard.client'
import * as RbacClient from '@/systems/rbac.client'
import * as ServerSettingsClient from '@/systems/server-settings.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import { useLoggedInUser } from '@/systems/users.client'
import { useMutation } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'

export function ServerActionsDropdown() {
	const loggedInUser = useLoggedInUser()
	const playerCount = SquadServerClient.usePlayerCount()
	const hasPlayers = playerCount !== null && playerCount > 0
	const [canEndMatch, hasDisableUpdatesPerm, canDisableFogOfWar] = React.useMemo(() => [
		!!loggedInUser && RBAC.rbacUserHasPerms(loggedInUser, RBAC.perm('squad-server:end-match')) && hasPlayers,
		!!loggedInUser && RBAC.rbacUserHasPerms(loggedInUser, RBAC.perm('squad-server:disable-slm-updates')),
		!!loggedInUser && RBAC.rbacUserHasPerms(loggedInUser, RBAC.perm('squad-server:turn-fog-off')),
	], [loggedInUser, hasPlayers])

	const updatesToSquadServerDisabled = Zus.useStore(ServerSettingsClient.Store, s => s.saved?.updatesToSquadServerDisabled)
	const { disableUpdates, enableUpdates } = QD.useToggleSquadServerUpdates()
	const disableFogOfWarMutation = SquadServerClient.useDisableFogOfWarMutation()
	const { toast } = useToast()

	async function disableFogOfWar() {
		const res = await disableFogOfWarMutation.mutateAsync()
		switch (res.code) {
			case 'err:rcon':
				break
			case 'err:permission-denied':
				RbacClient.handlePermissionDenied(res)
				break
			case 'ok':
				toast({
					title: 'Fog of War disabled for current match',
					variant: 'default',
				})
				break
			default:
				assertNever(res)
		}
	}

	return (
		<EndMatchDialog>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button variant="secondary" size="sm">
						Server Actions
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DialogTrigger asChild>
						<DropdownMenuItem
							disabled={!canEndMatch}
							className="bg-destructive text-destructive-foreground space-x-1 focus:bg-red-600 data-noplayers:flex data-noplayers:flex-col"
							data-noplayers={!hasPlayers || undefined}
						>
							<span>End Match</span>
							{!hasPlayers && (
								<small>
									(disabled: Cannot end match when server is empty.)
								</small>
							)}
						</DropdownMenuItem>
					</DialogTrigger>
					{updatesToSquadServerDisabled
						? <DropdownMenuItem disabled={!hasDisableUpdatesPerm} onClick={enableUpdates}>Re-enable SLM Updates</DropdownMenuItem>
						: (
							<DropdownMenuItem
								title="Prevents SLM from setting layers on the Squad Server"
								disabled={!hasDisableUpdatesPerm}
								onClick={disableUpdates}
							>
								Disable SLM Updates
							</DropdownMenuItem>
						)}
					<DropdownMenuItem
						title="Disables Fog Of War for the current match"
						disabled={!canDisableFogOfWar}
						onClick={disableFogOfWar}
					>
						Disable Fog Of War
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</EndMatchDialog>
	)
}

function EndMatchDialog(props: { children: React.ReactNode }) {
	const [isOpen, setIsOpen] = React.useState(false)

	const loggedInUser = useLoggedInUser()
	const endMatchMutation = useMutation(RPC.orpc.squadServer.endMatch.mutationOptions({}))
	const serverInfoRes = SquadServerClient.useServerInfoRes()
	if (!serverInfoRes || serverInfoRes?.code !== 'ok') return null
	const serverInfo = serverInfoRes.data

	async function endMatch() {
		const res = await endMatchMutation.mutateAsync(null)
		switch (res.code) {
			case 'ok':
				globalToast$.next({ title: 'Match ended!' })
				break
			case 'err:permission-denied':
				RbacClient.handlePermissionDenied(res)
				break
			case 'err:timeout':
			case 'err:unknown':
				globalToast$.next({ title: res.message, variant: 'destructive' })
				break
			default:
				assertNever(res)
		}
		setIsOpen(false)
	}

	const canEndMatch = !loggedInUser || RBAC.rbacUserHasPerms(loggedInUser, RBAC.perm('squad-server:end-match'))
	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			{props.children}
			<DialogContent>
				<DialogHeader>
					<DialogTitle>End Match</DialogTitle>
				</DialogHeader>
				<DialogDescription>
					Are you sure you want to end the match for <b>{serverInfo?.name}</b>?
				</DialogDescription>
				<DialogFooter>
					<Button disabled={!canEndMatch || endMatchMutation.isPending} onClick={endMatch} variant="destructive">
						{endMatchMutation.isPending && <Icons.Loader2 className="mr-2 h-4 w-4 animate-spin" />}
						End Match
					</Button>
					<Button
						onClick={() => {
							setIsOpen(false)
						}}
						variant="secondary"
					>
						Cancel
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
