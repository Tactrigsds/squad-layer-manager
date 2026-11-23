import * as dateFns from 'date-fns'
import * as Icons from 'lucide-react'
import React from 'react'

import { PermissionDeniedTooltip } from '@/components/permission-denied-tooltip'
import { Timer } from '@/components/timer'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import VoteTallyBars from '@/components/vote-tally-bars'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import { assertNever } from '@/lib/type-guards'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as V_Msgs from '@/messages/vote.messages'
import * as V from '@/models/vote.models'
import * as MatchHistoryClient from '@/systems/match-history.client'
import { tr } from '@/systems/messages.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as VoteClient from '@/systems/vote.client'

namespace Sel {
	export function savedQueue(s: SquadServerFrame.State) {
		return s.queue.rbSession.localState.savedList
	}
	export function defaultDisplayProps(s: SquadServerFrame.State) {
		return SquadServerFrame.Sel.settings(s).vote.voteDisplayProps
	}
}

function statusLabel(code: V.VoteView['code']) {
	switch (code) {
		case 'in-progress':
			return tr.text(V_Msgs.status.inProgress())
		case 'ended:winner':
			return tr.text(V_Msgs.status.ended())
		case 'ended:insufficient-votes':
			return tr.text(V_Msgs.status.insufficientVotes())
		case 'ended:aborted':
			return tr.text(V_Msgs.status.aborted())
		default:
			assertNever(code)
	}
}

// The server's running vote, layer or simple, or the one that ended last while its result is still shown, floated over
// the activity feed. Collapsing applies to one vote, so the next vote opens expanded.
export default function VoteBox(props: { stores: SquadServerFrame.KeyProp; className?: string }) {
	const serverId = props.stores.squadServer.serverId
	const layerVoteState = VoteClient.useVoteState(serverId)
	const simpleVoteState = VoteClient.useShownSimpleVoteState(serverId)
	const currentMatch = MatchHistoryClient.useCurrentMatch(serverId)
	const savedQueue = Zus.useStore(props.stores.squadServer, Sel.savedQueue)
	const defaultDisplayProps = Zus.useStore(props.stores.squadServer, Sel.defaultDisplayProps)
	const [collapsedKey, setCollapsedKey] = React.useState<string | null>(null)
	const manageDenied = RbacClient.useAccess('vote.endVoteEarly', { serverId })
	const serverInfoRes = SquadServerClient.useServerInfoRes(serverId)

	const view = V.shownVote([
		V.layerVoteView(savedQueue, layerVoteState, defaultDisplayProps, currentMatch?.startTime),
		simpleVoteState && V.simpleVoteView(simpleVoteState),
	])
	if (!view) return null

	const playerCount = serverInfoRes?.code === 'ok' ? serverInfoRes.data.playerCount : null
	const inProgress = view.code === 'in-progress'
	const voteId = view.voteId
	const collapsed = collapsedKey === view.key
	const tally = V.tallyView(view, playerCount ?? 0)
	const heading = tr.text(V_Msgs.heading())

	return (
		<section
			aria-label={heading}
			className={cn('rounded-md border bg-panel text-xs shadow-md', collapsed ? 'w-max' : 'w-72', props.className)}
		>
			<div className="flex items-center gap-1.5 ps-2 pe-0.5 py-0.5">
				<Icons.Vote className="size-3.5 shrink-0 text-info" />
				<span className="font-semibold truncate">{heading}</span>
				{inProgress ? (
					<Badge variant="outline">
						<Timer className="font-mono" formatTime={(ms) => dateFns.format(new Date(ms), 'm:ss')} deadline={view.deadline} zeros />
					</Badge>
				) : (
					<span className="text-text-3 truncate">{statusLabel(view.code)}</span>
				)}
				<span className="flex-1" />
				<Button
					variant="ghost"
					size="icon-sm"
					aria-expanded={!collapsed}
					title={tr.text(collapsed ? V_Msgs.box.expand() : V_Msgs.box.collapse())}
					onClick={() => setCollapsedKey(collapsed ? null : view.key)}
				>
					{collapsed ? <Icons.ChevronDown /> : <Icons.ChevronUp />}
				</Button>
			</div>
			{!collapsed && (
				<div className="flex flex-col gap-1.5 px-2 pb-2">
					<VoteTallyBars
						total={tally.totalVotes}
						rows={view.choices.map((choice, index) => ({
							key: choice.id,
							label: tr.text(V_Msgs.box.choiceLabel(index + 1, choice.label)),
							votes: tally.totals.get(choice.id) ?? 0,
							won: choice.id === view.winnerId,
						}))}
						footer={
							playerCount !== null
								? tr.text(V_Msgs.turnout(tally.totalVotes, playerCount, playerCount > 0 ? tally.turnoutPercentage : null))
								: null
						}
					/>
					{inProgress && (
						<div className="flex flex-wrap justify-end gap-1">
							<PermissionDeniedTooltip denied={manageDenied}>
								<Button
									size="sm"
									variant="ghost"
									disabled={!!manageDenied}
									onClick={() => voteId && void VoteClient.Actions.endVoteEarly(serverId, voteId)}
								>
									<Icons.CheckCheck />
									{tr.text(V_Msgs.endVoteEarly())}
								</Button>
							</PermissionDeniedTooltip>
							<PermissionDeniedTooltip denied={manageDenied}>
								<Button
									size="sm"
									variant="ghost"
									disabled={!!manageDenied}
									onClick={() => voteId && void VoteClient.Actions.abortVote(serverId, voteId)}
								>
									<Icons.Ban />
									{tr.text(V_Msgs.abortVote())}
								</Button>
							</PermissionDeniedTooltip>
						</div>
					)}
				</div>
			)}
		</section>
	)
}
