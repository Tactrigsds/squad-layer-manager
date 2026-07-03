import type * as SquadServerFrame from '@/frames/squad-server.frame'
import { cn } from '@/lib/utils'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import type * as SM from '@/models/squad.models'
import React from 'react'
import SquadContextMenuOptions from './squad-context-menu-options'
import type { SquadDetailsWindowProps } from './squad-details-window.helpers'
import { MatchTeamDisplay } from './teams-display'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from './ui/context-menu'
import { OpenWindowInteraction } from './ui/draggable-window'

void import('@/components/squad-details-window')

interface SquadDisplayProps {
	squad: Pick<SM.Squad, 'squadId' | 'squadName' | 'teamId'> & { uniqueId?: number }
	className?: string
	showName?: boolean
	showTeam?: boolean
	showMenu?: boolean
	matchId: number
	stores: SquadServerFrame.KeyProp
}

function SquadButton(
	{ label, ref, className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
		label: string
		ref?: React.Ref<HTMLButtonElement>
	},
) {
	return (
		<button ref={ref} type="button" className={cn('hover:underline cursor-pointer', className)} {...props}>
			{label}
		</button>
	)
}

export function SquadDisplay({ squad, matchId, className, showName = true, showTeam = false, showMenu = true, stores }: SquadDisplayProps) {
	const isDefaultName = squad.squadName === `Squad ${squad.squadId}`
	const label = isDefaultName
		? `Squad ${squad.squadId}`
		: `Squad ${squad.squadId}${showName ? ` "${squad.squadName}"` : ''}`
	const labelClass = isDefaultName ? 'font-bold' : 'font-bold'

	const squadLabel = squad.uniqueId !== undefined
		? (
			<OpenWindowInteraction
				windowId={WINDOW_ID.enum['squad-details']}
				windowProps={{ uniqueSquadId: squad.uniqueId, stores } satisfies SquadDetailsWindowProps}
				preload="intent"
				render={SquadButton}
				label={label}
				className={labelClass}
			/>
		)
		: <span className={labelClass}>{label}</span>

	const labelWithMenu = showMenu
		? (
			<ContextMenu>
				<ContextMenuTrigger>{squadLabel}</ContextMenuTrigger>
				<ContextMenuContent>
					<SquadContextMenuOptions squad={squad} stores={stores} />
				</ContextMenuContent>
			</ContextMenu>
		)
		: squadLabel

	return (
		<span className={cn('inline-flex flex-nowrap items-center gap-1', className)}>
			{labelWithMenu}
			{showTeam && (
				<span className="inline-flex flex-nowrap">
					(
					<MatchTeamDisplay teamId={squad.teamId} matchId={matchId} stores={stores} />)
				</span>
			)}
		</span>
	)
}
