import { PermissionDeniedTooltip } from '@/components/permission-denied-tooltip'
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
import { useMutation } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'

export function ServerActionsDropdown() {
	const playerCount = SquadServerClient.usePlayerCount()
	const hasPlayers = playerCount !== null && playerCount > 0
	const endMatchDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:end-match'))
	const disableUpdatesDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:disable-slm-updates'))
	const disableFogOfWarDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:turn-fog-off'))

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
					<PermissionDeniedTooltip denied={endMatchDenied}>
						<DialogTrigger asChild>
							<DropdownMenuItem
								disabled={!!endMatchDenied || !hasPlayers}
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
					</PermissionDeniedTooltip>
					{updatesToSquadServerDisabled
						? (
							<PermissionDeniedTooltip denied={disableUpdatesDenied}>
								<DropdownMenuItem disabled={!!disableUpdatesDenied} onClick={enableUpdates}>Re-enable SLM Updates</DropdownMenuItem>
							</PermissionDeniedTooltip>
						)
						: (
							<PermissionDeniedTooltip denied={disableUpdatesDenied}>
								<DropdownMenuItem
									disabled={!!disableUpdatesDenied}
									onClick={disableUpdates}
								>
									Disable SLM Updates
								</DropdownMenuItem>
							</PermissionDeniedTooltip>
						)}
					<PermissionDeniedTooltip denied={disableFogOfWarDenied}>
						<DropdownMenuItem
							disabled={!!disableFogOfWarDenied}
							onClick={disableFogOfWar}
						>
							Disable Fog Of War
						</DropdownMenuItem>
					</PermissionDeniedTooltip>
				</DropdownMenuContent>
			</DropdownMenu>
		</EndMatchDialog>
	)
}

function EndMatchDialog(props: { children: React.ReactNode }) {
	const [isOpen, setIsOpen] = React.useState(false)

	const endMatchDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:end-match'))
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
					<PermissionDeniedTooltip denied={endMatchDenied}>
						<Button disabled={!!endMatchDenied || endMatchMutation.isPending} onClick={endMatch} variant="destructive">
							{endMatchMutation.isPending && <Icons.Loader2 className="mr-2 h-4 w-4 animate-spin" />}
							End Match
						</Button>
					</PermissionDeniedTooltip>
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
