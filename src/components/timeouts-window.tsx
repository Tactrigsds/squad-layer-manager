import * as dateFns from 'date-fns'
import React from 'react'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { frameManager } from '@/frames/frame-manager'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import * as FRM from '@/lib/frame'
import { toast } from '@/lib/toast'
import * as Zus from '@/lib/zustand'
import * as SM_Msgs from '@/messages/squad.messages'
import type * as AppEvents from '@/models/app-events.models'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import * as SM from '@/models/squad.models'
import { DraggableWindowStore } from '@/systems/draggable-window.client'
import { tr } from '@/systems/messages.client'
import * as SettingsClient from '@/systems/settings.client'
import * as TimeoutsClient from '@/systems/timeouts.client'
import * as UsersClient from '@/systems/users.client'

import { CopyIdButton } from './copy-id-button'
import { PlayerDisplay } from './player-display'
import type { TimeoutsWindowProps } from './timeouts-window.helpers'
import { DraggableWindowClose, DraggableWindowDragBar, DraggableWindowTitle, useDraggableWindow } from './ui/draggable-window'

DraggableWindowStore.getState().registerDefinition<TimeoutsWindowProps, unknown>({
	type: WINDOW_ID.enum['timeouts'],
	component: TimeoutsWindow,
	initialPosition: 'left',
	resizable: true,
	minWidth: 480,
	minHeight: 200,
	defaultWidth: 720,
	defaultHeight: 420,
	getId: () => 'timeouts',
})

type ActiveTimeout = ReturnType<typeof TimeoutsClient.useActiveTimeouts>[number]

// a timed-out player is by definition off the roster, so their live position is unknown and the admin list isn't
// joined in: the row carries identity only.
function TimeoutPlayer({ timeout, stores }: { timeout: ActiveTimeout; stores: SquadServerFrame.KeyProp | undefined }) {
	if (timeout.username === null || !stores) {
		return timeout.steamId !== null ? (
			<CopyIdButton kind="steam" id={timeout.steamId.toString()} />
		) : (
			<CopyIdButton kind="eos" id={timeout.playerId} />
		)
	}
	const ids = { eos: timeout.playerId, username: timeout.username, steam: timeout.steamId?.toString() }
	return <PlayerDisplay player={SM.fromRecentPlayer({ ids, isAdmin: false })} stores={stores} />
}

function TimeoutsWindow() {
	useDraggableWindow()
	const timeouts = TimeoutsClient.useActiveTimeouts()
	const canCancel = TimeoutsClient.useCanCancelSomeTimeout()
	const cancelMutation = TimeoutsClient.useCancelTimeoutMutation()

	const userIds = [...new Set(timeouts.flatMap((t) => (t.actor?.type === 'slm-user' ? [t.actor.userId] : [])))]
	const usersRes = UsersClient.useUsers(userIds, { enabled: userIds.length > 0 })
	const userMap = new Map((usersRes.data?.code === 'ok' ? usersRes.data.users : []).map((u) => [u.discordId, u]))

	// PlayerDisplay is server-scoped (the details window it opens queries per server), and this window lists timeouts
	// from every server at once, so each row resolves against the server that issued its timeout rather than whichever
	// server the window was opened from. A server that isn't usable gets no frame, and its rows fall back to the ids.
	const settings = Zus.useStore(SettingsClient.PublicSettingsStore)
	const storesByServer = React.useMemo(() => {
		const entries = [...new Set(timeouts.flatMap((t) => t.issuedServerId ?? []))].flatMap((serverId) => {
			const server = settings?.servers.find((s) => s.id === serverId)
			if (!SettingsClient.isServerUsable(server)) return []
			const key = frameManager.ensureSetup(SquadServerFrame.frame, SquadServerFrame.createInput(serverId))
			return [[serverId, FRM.toProp(key)] as const]
		})
		return new Map(entries)
	}, [timeouts, settings])

	function actorName(actor: AppEvents.Actor | null, actorUsername: string | null): string {
		if (actor?.type === 'slm-user') return userMap.get(actor.userId)?.displayName ?? SM_Msgs.timeoutActorFallbacks['slm-user']
		if (actor?.type === 'ingame-user') return actorUsername ?? SM_Msgs.timeoutActorFallbacks['ingame-user']
		return SM_Msgs.timeoutActorFallbacks.system
	}

	async function cancel(timeoutId: string) {
		const res = await cancelMutation.mutateAsync({ timeoutId })
		if (res.code !== 'ok') toast.error(...tr.toast(SM_Msgs.cancelTimeoutFailed('msg' in res && res.msg ? res.msg : res.code)))
		else toast(...tr.toast(SM_Msgs.timeoutCancelled()))
	}

	return (
		<div className="min-w-0 min-h-0 flex-1 flex flex-col">
			<DraggableWindowDragBar>
				<DraggableWindowTitle>{tr.text(SM_Msgs.activeTimeoutsTitle())}</DraggableWindowTitle>
				<DraggableWindowClose />
			</DraggableWindowDragBar>
			<p className="px-3 pt-2 text-xs text-muted-foreground">{tr.text(SM_Msgs.activeTimeoutsBlurb())}</p>
			<ScrollArea className="min-h-0 grow px-3 pb-2">
				{timeouts.length === 0 ? (
					<p className="py-2 text-sm text-muted-foreground">{tr.text(SM_Msgs.noActiveTimeouts())}</p>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{tr.text(SM_Msgs.timeoutPlayerColumn())}</TableHead>
								<TableHead>{tr.text(SM_Msgs.timeoutExpiresColumn())}</TableHead>
								<TableHead>{tr.text(SM_Msgs.timeoutReasonColumn())}</TableHead>
								<TableHead>{tr.text(SM_Msgs.timeoutIssuedColumn())}</TableHead>
								{canCancel && <TableHead className="w-8" />}
							</TableRow>
						</TableHeader>
						<TableBody>
							{timeouts.map((t) => (
								<TableRow key={t.id}>
									<TableCell className="align-top">
										<TimeoutPlayer timeout={t} stores={t.issuedServerId ? storesByServer.get(t.issuedServerId) : undefined} />
									</TableCell>
									<TableCell className="align-top whitespace-nowrap" title={dateFns.format(t.expiresAt, 'PPp')}>
										{dateFns.formatDistanceToNow(t.expiresAt, { addSuffix: true })}
									</TableCell>
									<TableCell className="align-top min-w-0 wrap-break-word text-muted-foreground">
										{t.reasonMessage ? (
											<>
												{t.reasonLabel && (
													<span className="font-medium text-foreground">
														{t.reasonLabel}
														{': '}
													</span>
												)}
												{t.reasonMessage}
											</>
										) : (
											<span className="italic">{tr.text(SM_Msgs.noTimeoutReason())}</span>
										)}
									</TableCell>
									<TableCell
										className="align-top whitespace-nowrap text-xs text-muted-foreground"
										title={dateFns.format(t.createdAt, 'PPp')}
									>
										<div>{actorName(t.actor, t.actorUsername)}</div>
										<div>{dateFns.formatDistanceToNow(t.createdAt, { addSuffix: true })}</div>
									</TableCell>
									{canCancel && (
										<TableCell className="align-top">
											<Button
												size="sm"
												variant="outline"
												className="h-6 px-2"
												title={tr.text(SM_Msgs.cancelTimeoutHint())}
												onClick={() => void cancel(t.id)}
											>
												{tr.text(SM_Msgs.cancelTimeout())}
											</Button>
										</TableCell>
									)}
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</ScrollArea>
		</div>
	)
}
