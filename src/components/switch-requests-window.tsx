import * as Icons from 'lucide-react'
import React from 'react'

import { PermissionDeniedTooltip } from '@/components/permission-denied-tooltip'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { frameManager } from '@/frames/frame-manager'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import * as FRM from '@/lib/frame'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as SRQ_Msgs from '@/messages/switch-requests.messages'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import * as SM from '@/models/squad.models'
import * as RBAC from '@/rbac.models'
import { DraggableWindowStore } from '@/systems/draggable-window.client'
import { tr } from '@/systems/messages.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SRQClient from '@/systems/switch-requests.client'

import { PlayerDisplay } from './player-display'
import type { SwitchRequestsWindowProps } from './switch-requests-window.helpers'
import { MatchTeamDisplay } from './teams-display'
import { DraggableWindowClose, DraggableWindowDragBar, DraggableWindowTitle, useDraggableWindow } from './ui/draggable-window'

DraggableWindowStore.getState().registerDefinition<SwitchRequestsWindowProps, unknown>({
	type: WINDOW_ID.enum['switch-requests'],
	component: SwitchRequestsWindow,
	initialPosition: 'left',
	resizable: true,
	minWidth: 420,
	minHeight: 180,
	defaultWidth: 560,
	defaultHeight: 320,
	getId: (props) => `switch-requests:${props.serverId}`,
})

function SwitchRequestsWindow(props: SwitchRequestsWindowProps) {
	useDraggableWindow()
	const stores: SquadServerFrame.KeyProp = React.useMemo(
		() => FRM.toProp(frameManager.ensureSetup(SquadServerFrame.frame, SquadServerFrame.createInput(props.serverId))),
		[props.serverId],
	)
	const count = Zus.useStore(stores.squadServer!, SRQClient.Sel.requestCount)
	// the heads of two non-empty queues trade places automatically; outline them so the pairing is visible
	const mutualReady = Zus.useStore(
		stores.squadServer!,
		(s) => SRQClient.Sel.queueForTeam(1)(s).length > 0 && SRQClient.Sel.queueForTeam(2)(s).length > 0,
	)
	return (
		<div className="min-w-0 min-h-0 flex-1 flex flex-col">
			<DraggableWindowDragBar>
				<DraggableWindowTitle>{tr.text(SRQ_Msgs.windowTitle())}</DraggableWindowTitle>
				<DraggableWindowClose />
			</DraggableWindowDragBar>
			<p className="px-3 pt-2 text-xs text-muted-foreground">{tr.text(SRQ_Msgs.windowBlurb())}</p>
			<ScrollArea className="min-h-0 grow px-3 pb-2">
				{count === 0 ? (
					<p className="py-2 text-sm text-muted-foreground">{tr.text(SRQ_Msgs.noRequests())}</p>
				) : (
					<div className="grid grid-cols-2 divide-x divide-border pt-2">
						<DirectionColumn fromTeam={1} mutualReady={mutualReady} className="pr-2" stores={stores} />
						<DirectionColumn fromTeam={2} mutualReady={mutualReady} className="pl-2" stores={stores} />
					</div>
				)}
			</ScrollArea>
		</div>
	)
}

function DirectionColumn(props: { fromTeam: SM.TeamId; mutualReady: boolean; className?: string; stores: SquadServerFrame.KeyProp }) {
	const { fromTeam, stores } = props
	const entries = Zus.useStore(stores.squadServer!, SRQClient.Sel.queueForTeam(fromTeam))
	const switchNowDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:manage-players', { serverId: stores.squadServer!.serverId }))
	return (
		<div className={cn('flex flex-col gap-0.5 min-w-0', props.className)}>
			<div className="flex items-center gap-1 pb-1 text-xs text-muted-foreground whitespace-nowrap">
				<MatchTeamDisplay teamId={fromTeam} leadWithTeamName stores={stores} />
				<Icons.ArrowRight className="h-3 w-3 shrink-0" />
				<MatchTeamDisplay teamId={SM.oppositeTeamId(fromTeam)} leadWithTeamName stores={stores} />
				<span>({entries.length})</span>
			</div>
			{entries.map((entry) => (
				<div
					key={entry.playerId}
					title={props.mutualReady && entry.position === 1 ? tr.text(SRQ_Msgs.mutualPairHint()) : undefined}
					className={cn(
						'flex items-center gap-2 rounded px-1 min-w-0',
						props.mutualReady && entry.position === 1 && 'outline-dashed outline-1 outline-amber-500/60',
					)}
				>
					<span className="w-4 text-right text-xs text-muted-foreground tabular-nums shrink-0">{entry.position}</span>
					<span className="min-w-0 truncate">
						{entry.player ? (
							<PlayerDisplay player={entry.player} stores={stores} />
						) : (
							<span className="text-muted-foreground">{entry.playerId}</span>
						)}
					</span>
					<span className="ml-auto shrink-0">
						<PermissionDeniedTooltip denied={switchNowDenied}>
							<Button
								variant="ghost"
								size="icon"
								className="h-6 w-6"
								disabled={!!switchNowDenied || entry.switching}
								title={tr.text(SRQ_Msgs.switchNowHint())}
								onClick={() => void SRQClient.Actions.switchNow(stores, entry.playerId)}
							>
								{entry.switching ? (
									<Icons.LoaderCircle className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
								) : (
									<Icons.ArrowLeftRight className="h-3.5 w-3.5 text-amber-500" />
								)}
							</Button>
						</PermissionDeniedTooltip>
					</span>
				</div>
			))}
		</div>
	)
}
