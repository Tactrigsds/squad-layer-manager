import * as ChatPrt from '@/frame-partials/chat.partial'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as CHAT_Msgs from '@/messages/chat.messages'
import * as MsgFmt from '@/messages/format'
import * as MatchHistoryClient from '@/systems/match-history.client'
import { tr } from '@/systems/messages.client'

import ShortLayerName from './short-layer-name.tsx'

// The strip above anything drawn from the match selected in Match History rather than the live one. Renders nothing
// while the live match is shown. `returnToLive` adds a way back, for a panel that has no live button of its own.
export default function HistoricalMatchBanner(props: { stores: SquadServerFrame.KeyProp; returnToLive?: boolean; className?: string }) {
	const squadServer = props.stores.squadServer!
	const serverId = squadServer.serverId
	const selectedMatchOrdinal = Zus.useStore(squadServer, ChatPrt.Sel.selectedMatchOrdinal)
	const match = Zus.useStore_Susp(
		squadServer,
		MatchHistoryClient.currentMatch$(serverId),
		MatchHistoryClient.recentMatches$(serverId),
		ChatPrt.Sel.displayMatch,
	)
	if (selectedMatchOrdinal === null || !match) return null
	return (
		<div
			role="status"
			className={cn(
				'flex flex-wrap items-center justify-center gap-x-2.5 gap-y-0.5 text-text-2 text-xs py-1 px-2 bg-[rgba(91,141,239,0.12)] text-center',
				props.className,
			)}
		>
			<span>
				{tr.richText(
					CHAT_Msgs.viewingHistoricalMatch(
						<ShortLayerName layerId={match.layerId} teamParity={match.ordinal % 2} />,
						match.startTime ? MsgFmt.formatDate(match.startTime, 'dateTime24') : undefined,
					),
				)}
			</span>
			{props.returnToLive && (
				<button
					type="button"
					className="font-semibold text-info hover:text-foreground hover:underline"
					onClick={() => void ChatPrt.Actions.setSelectedMatchOrdinal({ chat: squadServer }, null)}
				>
					{tr.text(CHAT_Msgs.returnToLive())}
				</button>
			)}
		</div>
	)
}
