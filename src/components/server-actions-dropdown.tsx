import { PermissionDeniedTooltip } from '@/components/permission-denied-tooltip'
import type { MenuSlots } from '@/components/player-context-menu-options'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useAlertDialog } from '@/components/ui/lazy-alert-dialog'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import { globalToast$ } from '@/hooks/use-global-toast.ts'
import { useToast } from '@/hooks/use-toast'
import { assertNever } from '@/lib/type-guards.ts'
import { cn } from '@/lib/utils'
import * as ZusUtils from '@/lib/zustand'
import * as RPC from '@/orpc.client.ts'
import * as RBAC from '@/rbac.models'
import * as LayerQueueClient from '@/systems/layer-queue.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import { useMutation } from '@tanstack/react-query'
import * as Icons from 'lucide-react'

const dropdownMenuSlots: MenuSlots = {
	Item: DropdownMenuItem,
	Separator: DropdownMenuSeparator,
	Sub: DropdownMenuSub,
	SubTrigger: DropdownMenuSubTrigger,
	SubContent: DropdownMenuSubContent,
}

export function ServerActionsDropdown(props: { stores: SquadServerFrame.KeyProp }) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="secondary" size="sm">
					Server Actions
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent>
				<ServerActionMenuItems stores={props.stores} slots={dropdownMenuSlots} />
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

export function ServerActionMenuItems(props: { stores: SquadServerFrame.KeyProp; slots: MenuSlots }) {
	const { Item } = props.slots
	const stores = props.stores
	const serverId = stores.squadServer!.serverId
	const playerCount = ZusUtils.useStore(
		stores.squadServer!,
		s => (s.chat.chatState.synced && !s.chat.chatState.connectionError) ? s.chat.chatState.interpolatedState.players.length : null,
	)
	const hasPlayers = playerCount !== null && playerCount > 0
	const endMatchDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:end-match'))
	const disableUpdatesDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:disable-slm-updates'))
	const disableFogOfWarDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:turn-fog-off'))

	const updatesToSquadServerDisabled = ZusUtils.useStore(stores.squadServer!, s => s.settings.saved?.updatesToSquadServerDisabled)
	const { disableUpdates, enableUpdates } = LayerQueueClient.useToggleSquadServerUpdates(serverId)
	const disableFogOfWarMutation = SquadServerClient.useDisableFogOfWarMutation()
	const endMatchMutation = useMutation(RPC.orpc.squadServer.endMatch.mutationOptions({}))
	const serverInfoRes = SquadServerClient.useServerInfoRes(serverId)
	const openDialog = useAlertDialog()
	const { toast } = useToast()

	async function disableFogOfWar() {
		const res = await disableFogOfWarMutation.mutateAsync(serverId)
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

	async function endMatch() {
		const serverName = serverInfoRes?.code === 'ok' ? serverInfoRes.data.name : serverId
		const result = await openDialog({
			title: 'End Match',
			description: `Are you sure you want to end the match for ${serverName}?`,
			buttons: [{ id: 'confirm', label: 'End Match', variant: 'destructive' }],
		})
		if (result !== 'confirm') return
		const res = await endMatchMutation.mutateAsync({ serverId })
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
	}

	return (
		<>
			<PermissionDeniedTooltip denied={endMatchDenied}>
				<Item
					disabled={!!endMatchDenied || !hasPlayers}
					onClick={() => void endMatch()}
					className={cn(
						'bg-destructive text-destructive-foreground space-x-1 focus:bg-red-600',
						!hasPlayers && 'flex flex-col',
					)}
				>
					<span>End Match</span>
					{!hasPlayers && (
						<small>
							(disabled: Cannot end match when server is empty.)
						</small>
					)}
				</Item>
			</PermissionDeniedTooltip>
			{updatesToSquadServerDisabled
				? (
					<PermissionDeniedTooltip denied={disableUpdatesDenied}>
						<Item disabled={!!disableUpdatesDenied} onClick={enableUpdates}>Re-enable SLM Updates</Item>
					</PermissionDeniedTooltip>
				)
				: (
					<PermissionDeniedTooltip denied={disableUpdatesDenied}>
						<Item
							disabled={!!disableUpdatesDenied}
							onClick={disableUpdates}
						>
							Disable SLM Updates
						</Item>
					</PermissionDeniedTooltip>
				)}
			<PermissionDeniedTooltip denied={disableFogOfWarDenied}>
				<Item
					disabled={!!disableFogOfWarDenied}
					onClick={disableFogOfWar}
				>
					Disable Fog Of War
				</Item>
			</PermissionDeniedTooltip>
		</>
	)
}
