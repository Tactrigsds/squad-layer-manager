import { PermissionDeniedTooltip } from '@/components/permission-denied-tooltip'
import type { MenuSlots } from '@/components/player-context-menu-options'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useAlertDialog } from '@/components/ui/lazy-alert-dialog'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import { toast } from '@/lib/toast'
import { assertNever } from '@/lib/type-guards.ts'
import { cn } from '@/lib/utils'
import * as ZusUtils from '@/lib/zustand'
import * as Messages from '@/messages'
import * as RPC from '@/orpc.client.ts'
import * as RBAC from '@/rbac.models'
import * as LayerQueueClient from '@/systems/layer-queue.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as UsersClient from '@/systems/users.client'
import { useMutation } from '@tanstack/react-query'

// Permission checks gate these menu items, so a denial at call time is a race. Surface it the same
// way handlePermissionDenied would (refresh perms + user-facing message), but as a thrown error so a
// wrapping toast.promise renders a single error toast instead of double-toasting.
function permissionDeniedError(res: RBAC.PermissionDeniedResponse) {
	UsersClient.invalidateLoggedInUser()
	return new Error(Messages.WARNS.permissionDenied(res))
}

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

	function disableFogOfWar() {
		toast.promise(
			(async () => {
				const res = await disableFogOfWarMutation.mutateAsync(serverId)
				switch (res.code) {
					case 'ok':
						return res
					case 'err:permission-denied':
						throw permissionDeniedError(res)
					case 'err:rcon':
						throw new Error('Failed to disable Fog of War (RCON error)')
					case 'err:server-not-loaded':
						throw new Error(res.msg)
					default:
						assertNever(res)
				}
			})(),
			{
				loading: 'Disabling Fog of War...',
				success: 'Fog of War disabled for current match',
				error: (e: Error) => ({ message: e.message, richColors: true }),
			},
		)
	}

	async function endMatch() {
		const serverName = serverInfoRes?.code === 'ok' ? serverInfoRes.data.name : serverId
		const result = await openDialog({
			title: 'End Match',
			description: `Are you sure you want to end the match for ${serverName}?`,
			buttons: [{ id: 'confirm', label: 'End Match', variant: 'destructive' }],
		})
		if (result !== 'confirm') return
		toast.promise(
			(async () => {
				const res = await endMatchMutation.mutateAsync({ serverId })
				switch (res.code) {
					case 'ok':
						return res
					case 'err:permission-denied':
						throw permissionDeniedError(res)
					case 'err:timeout':
					case 'err:unknown':
						throw new Error(res.message)
					case 'err:server-not-loaded':
						throw new Error(res.msg)
					default:
						assertNever(res)
				}
			})(),
			{
				loading: `Ending match on ${serverName}...`,
				success: 'Match ended!',
				error: (e: Error) => ({ message: e.message, richColors: true }),
			},
		)
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
