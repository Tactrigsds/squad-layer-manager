import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/lib/toast'
import type * as AppEvents from '@/models/app-events.models'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import { DraggableWindowStore } from '@/systems/draggable-window.client'
import * as TimeoutsClient from '@/systems/timeouts.client'
import * as UsersClient from '@/systems/users.client'
import * as dateFns from 'date-fns'
import { CopyIdButton } from './copy-id-button'
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

function TimeoutsWindow() {
	useDraggableWindow()
	const timeouts = TimeoutsClient.useActiveTimeouts()
	const canCancel = TimeoutsClient.useMaxTimeout() !== undefined
	const cancelMutation = TimeoutsClient.useCancelTimeoutMutation()

	const userIds = [...new Set(timeouts.flatMap(t => (t.actor?.type === 'slm-user' ? [t.actor.userId] : [])))]
	const usersRes = UsersClient.useUsers(userIds, { enabled: userIds.length > 0 })
	const userMap = new Map((usersRes.data?.code === 'ok' ? usersRes.data.users : []).map(u => [u.discordId, u]))

	function actorName(actor: AppEvents.Actor | null): string {
		if (actor?.type === 'slm-user') return userMap.get(actor.userId)?.displayName ?? 'Admin'
		if (actor?.type === 'ingame-user') return 'In-game admin'
		return 'System'
	}

	async function cancel(timeoutId: string) {
		const res = await cancelMutation.mutateAsync({ timeoutId })
		if (res.code !== 'ok') toast.error('Cancel failed', { description: 'msg' in res && res.msg ? res.msg : res.code })
		else toast('Timeout cancelled')
	}

	return (
		<div className="min-w-0 min-h-0 flex-1 flex flex-col">
			<DraggableWindowDragBar>
				<DraggableWindowTitle>Active Timeouts</DraggableWindowTitle>
				<DraggableWindowClose />
			</DraggableWindowDragBar>
			<p className="px-3 pt-2 text-xs text-muted-foreground">
				Players with an active kick timeout are re-kicked on join from any SLM-managed server until it expires.
			</p>
			<ScrollArea className="min-h-0 grow px-3 pb-2">
				{timeouts.length === 0
					? <p className="py-2 text-sm text-muted-foreground">No active timeouts.</p>
					: (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Player</TableHead>
									<TableHead>Expires</TableHead>
									<TableHead>Reason</TableHead>
									<TableHead>Issued</TableHead>
									{canCancel && <TableHead className="w-8" />}
								</TableRow>
							</TableHeader>
							<TableBody>
								{timeouts.map(t => (
									<TableRow key={t.id}>
										<TableCell className="align-top">
											{t.username !== null && <div className="font-medium">{t.username}</div>}
											<div className="text-xs">
												{t.steamId !== null
													? <CopyIdButton label="steam" id={t.steamId.toString()} />
													: <CopyIdButton label="eos" id={t.playerId} />}
											</div>
										</TableCell>
										<TableCell className="align-top whitespace-nowrap" title={dateFns.format(t.expiresAt, 'PPp')}>
											{dateFns.formatDistanceToNow(t.expiresAt, { addSuffix: true })}
										</TableCell>
										<TableCell className="align-top min-w-0 wrap-break-word text-muted-foreground">
											{t.reasonMessage
												? (
													<>
														{t.reasonLabel && <span className="font-medium text-foreground">{t.reasonLabel}{': '}</span>}
														{t.reasonMessage}
													</>
												)
												: <span className="italic">none</span>}
										</TableCell>
										<TableCell
											className="align-top whitespace-nowrap text-xs text-muted-foreground"
											title={dateFns.format(t.createdAt, 'PPp')}
										>
											<div>{actorName(t.actor)}</div>
											<div>{dateFns.formatDistanceToNow(t.createdAt, { addSuffix: true })}</div>
										</TableCell>
										{canCancel && (
											<TableCell className="align-top">
												<Button
													size="sm"
													variant="outline"
													className="h-6 px-2"
													title="Cancel this timeout"
													onClick={() => void cancel(t.id)}
												>
													Cancel
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
