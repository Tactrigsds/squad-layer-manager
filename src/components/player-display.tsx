import { MatchTeamDisplay } from '@/components/teams-display'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import { cn } from '@/lib/utils'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import * as SM from '@/models/squad.models'
import { usePlayerGroupColor } from '@/systems/battlemetrics.client'
import { ContextMenu } from '@radix-ui/react-context-menu'
import * as Icons from 'lucide-react'
import React from 'react'
import PlayerContextMenuOptions from './player-context-menu-options'
import type { PlayerDetailsWindowProps } from './player-details-window.helpers'
import { ContextMenuContent, ContextMenuTrigger } from './ui/context-menu'
import { OpenWindowInteraction } from './ui/draggable-window'

void import('@/components/player-details-window')

export interface PlayerDisplayProps {
	player: SM.Player
	showTeam?: boolean
	showSquad?: boolean
	showRole?: boolean
	className?: string
	matchId: number
	stores: SquadServerFrame.KeyProp
	// when true, the name doesn't mount its own context menu so an enclosing one (e.g. the teams-panel
	// row's bulk-aware menu) handles the right-click instead
	disableContextMenu?: boolean
}

function PlayerButton(
	{ username, stores, ref, disableContextMenu, playerId, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
		username: string
		playerId: string
		stores: SquadServerFrame.KeyProp
		disableContextMenu?: boolean
		ref?: React.Ref<HTMLButtonElement>
	},
) {
	const button = (
		<button ref={ref} type="button" className="font-bold hover:underline cursor-pointer" {...props}>
			{username}
		</button>
	)
	if (disableContextMenu) return button
	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>{button}</ContextMenuTrigger>
			<ContextMenuContent>
				<PlayerContextMenuOptions playerId={playerId} stores={stores} />
			</ContextMenuContent>
		</ContextMenu>
	)
}

export function PlayerDisplay(
	{ player, showTeam, showSquad, showRole, className, matchId, stores, disableContextMenu }: PlayerDisplayProps,
) {
	const playerId = SM.PlayerIds.getPlayerId(player.ids)
	const windowProps: PlayerDetailsWindowProps = { playerId, stores }
	const groupColor = usePlayerGroupColor(playerId, player.adminGroups ?? [])

	return (
		<span className={cn('inline-flex items-baseline', className)}>
			{player.isAdmin && (
				<span
					title="This player is an Admin. Shift+click: select this team's admins. Shift+Ctrl+click: both teams"
					className="inline-block"
					onClickCapture={e => {
						if (!e.shiftKey) return
						e.preventDefault()
						e.stopPropagation()
						SquadServerFrame.Actions.selectAllAdmins(stores, e.ctrlKey ? undefined : player.teamId ?? undefined)
					}}
				>
					<Icons.ShieldCheckIcon className="h-[1em] w-[1em] text-background fill-blue-300" />
				</span>
			)}
			{player.isLeader && (
				<span title="Squad Leader">
					<Icons.Star className="h-3 w-3 text-yellow-500 fill-yellow-500 shrink-0" />
				</span>
			)}
			<OpenWindowInteraction
				windowId={WINDOW_ID.enum['player-details']}
				windowProps={windowProps}
				preload="intent"
				render={PlayerButton}
				username={player.ids.username}
				playerId={SM.PlayerIds.getPlayerId(player.ids)}
				stores={stores}
				disableContextMenu={disableContextMenu}
				style={groupColor ? { color: groupColor } : undefined}
			/>
			{(showTeam && player.teamId !== null) || (showSquad && player.squadId !== null)
				? (
					<span className="inline-flex flex-nowrap">
						({showTeam && player.teamId !== null && <MatchTeamDisplay matchId={matchId} teamId={player.teamId} stores={stores} />}
						{showTeam && player.teamId !== null && showSquad && player.squadId !== null && ', '}
						{showSquad && player.squadId !== null && player.squadId})
					</span>
				)
				: null}
			{showRole && player.role && (
				<span className="text-muted-foreground text-xs">
					[{player.role}]
				</span>
			)}
		</span>
	)
}
