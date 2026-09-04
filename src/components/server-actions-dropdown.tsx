import { useMutation } from '@tanstack/react-query'
import * as Icons from 'lucide-react'

import { PermissionDeniedTooltip } from '@/components/permission-denied-tooltip'
import type { MenuSlots } from '@/components/player-context-menu-options'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAlertDialog } from '@/components/ui/lazy-alert-dialog'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import { toast } from '@/lib/toast'
import { assertNever } from '@/lib/type-guards.ts'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as RBAC_Msgs from '@/messages/rbac.messages'
import * as SS_Msgs from '@/messages/server-state.messages'
import * as RPC from '@/orpc.client.ts'
import * as RBAC from '@/rbac.models'
import * as LayerQueueClient from '@/systems/layer-queue.client'
import { tr } from '@/systems/messages.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SandboxClient from '@/systems/sandbox.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as UsersClient from '@/systems/users.client'

import { useOpenSandboxControlWindow } from './sandbox-control-window.helpers'
import { useOpenServerConsoleWindow } from './server-console-window.helpers'

void import('@/components/sandbox-control-window')
void import('@/components/sandbox-panels')
void import('@/components/server-console-window')

// Permission checks gate these menu items, so a denial at call time is a race. Surface it the same
// way handlePermissionDenied would (refresh perms + user-facing message), but as a thrown error so a
// wrapping toast.promise renders a single error toast instead of double-toasting.
function permissionDeniedError(res: RBAC.PermissionDeniedResponse) {
	UsersClient.invalidateLoggedInUser()
	return new Error(tr.text(RBAC_Msgs.permissionDenied(res)))
}

export const dropdownMenuSlots: MenuSlots = {
	Item: DropdownMenuItem,
	Separator: DropdownMenuSeparator,
	Sub: DropdownMenuSub,
	SubTrigger: DropdownMenuSubTrigger,
	SubContent: DropdownMenuSubContent,
}

export function ServerActionsDropdown(props: { stores: SquadServerFrame.KeyProp; iconOnly?: boolean }) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				{props.iconOnly ? (
					<Button size="icon-sm" title={tr.text(SS_Msgs.serverActions())} aria-label={tr.text(SS_Msgs.serverActions())}>
						<Icons.Server />
					</Button>
				) : (
					<Button size="sm">{tr.text(SS_Msgs.serverActions())}</Button>
				)}
			</DropdownMenuTrigger>
			<DropdownMenuContent>
				<ServerActionMenuItems stores={props.stores} slots={dropdownMenuSlots} />
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

export function ServerActionMenuItems(props: { stores: SquadServerFrame.KeyProp; slots: MenuSlots }) {
	const { Item, Separator } = props.slots
	const stores = props.stores
	const serverId = stores.squadServer!.serverId
	const playerCount = Zus.useStore(stores.squadServer!, (s) =>
		s.chat.chatState.synced && !s.chat.chatState.connectionError ? s.chat.chatState.interpolatedState.players.size : null,
	)
	const hasPlayers = playerCount !== null && playerCount > 0
	const endMatchDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:end-match', { serverId: serverId }))
	const disableUpdatesDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:disable-slm-updates', { serverId: serverId }))
	const disableFogOfWarDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:turn-fog-off', { serverId: serverId }))

	const updatesToSquadServerDisabled = Zus.useStore(stores.squadServer!, (s) => s.settings.saved?.updatesToSquadServerDisabled)
	const { disableUpdates, enableUpdates } = LayerQueueClient.useToggleSquadServerUpdates(serverId)
	const enableIngameVoting = LayerQueueClient.useEnableIngameVoting(serverId)
	const disableFogOfWarMutation = SquadServerClient.useDisableFogOfWarMutation()
	const endMatchMutation = useMutation(RPC.orpc.squadServer.endMatch.mutationOptions({}))
	const serverInfoRes = SquadServerClient.useServerInfoRes(serverId)
	const openDialog = useAlertDialog()
	// only servers SLM emulates itself come back here, so this is both "is a sandbox" and "may drive it"
	const sandboxServersRes = SandboxClient.useSandboxServers()
	const isSandbox = !!sandboxServersRes.data?.includes(serverId)
	const openSandboxWindow = useOpenSandboxControlWindow({ serverId })
	const consoleDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:view-console', { serverId: serverId }))
	const openConsoleWindow = useOpenServerConsoleWindow({ serverId })

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
						throw new Error(tr.text(SS_Msgs.disableFogOfWarFailed()))
					case 'err:server-not-loaded':
						throw new Error(res.msg)
					default:
						assertNever(res)
				}
			})(),
			{
				loading: tr.text(SS_Msgs.disablingFogOfWar()),
				success: tr.text(SS_Msgs.fogOfWarDisabled()),
				error: (e: Error) => ({ message: e.message, richColors: true }),
			},
		)
	}

	async function endMatch() {
		const serverName = serverInfoRes?.code === 'ok' ? serverInfoRes.data.name : serverId
		const msg = tr.confirm(SS_Msgs.confirmEndMatch(serverName))
		const result = await openDialog({
			title: msg.title,
			description: msg.description,
			buttons: [{ id: 'confirm', label: msg.confirmLabel, variant: 'destructive' }],
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
				loading: tr.text(SS_Msgs.endingMatch(serverName)),
				success: tr.text(SS_Msgs.matchEnded()),
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
					className={cn('bg-destructive text-destructive-foreground space-x-1 focus:bg-danger', !hasPlayers && 'flex flex-col')}
				>
					<span>{tr.text(SS_Msgs.endMatchLabel())}</span>
					{!hasPlayers && <small>{tr.text(SS_Msgs.endMatchNeedsPlayers())}</small>}
				</Item>
			</PermissionDeniedTooltip>
			{updatesToSquadServerDisabled?.type !== 'ingame-vote' && (
				<PermissionDeniedTooltip denied={disableUpdatesDenied}>
					<Item disabled={!!disableUpdatesDenied} onClick={enableIngameVoting}>
						{tr.text(SS_Msgs.enableIngameVoting())}
					</Item>
				</PermissionDeniedTooltip>
			)}
			{updatesToSquadServerDisabled ? (
				<PermissionDeniedTooltip denied={disableUpdatesDenied}>
					<Item disabled={!!disableUpdatesDenied} onClick={enableUpdates}>
						{tr.text(SS_Msgs.reenableSlmUpdates())}
					</Item>
				</PermissionDeniedTooltip>
			) : (
				<PermissionDeniedTooltip denied={disableUpdatesDenied}>
					<Item disabled={!!disableUpdatesDenied} onClick={disableUpdates}>
						{tr.text(SS_Msgs.disableSlmUpdates())}
					</Item>
				</PermissionDeniedTooltip>
			)}
			<PermissionDeniedTooltip denied={disableFogOfWarDenied}>
				<Item disabled={!!disableFogOfWarDenied} onClick={disableFogOfWar}>
					{tr.text(SS_Msgs.disableFogOfWar())}
				</Item>
			</PermissionDeniedTooltip>
			<Separator />
			<PermissionDeniedTooltip denied={consoleDenied}>
				<Item disabled={!!consoleDenied} onClick={() => openConsoleWindow()}>
					{tr.text(SS_Msgs.serverConsole())}
				</Item>
			</PermissionDeniedTooltip>
			{isSandbox && <Item onClick={() => openSandboxWindow()}>{tr.text(SS_Msgs.sandboxControls())}</Item>}
		</>
	)
}
