import * as Icons from 'lucide-react'

import * as Atoms from '@/components/feed/atoms'
import * as MatchSummary from '@/components/feed/match-summary'
import * as HistoryMsgs from '@/messages/history.messages'
import * as L_Msgs from '@/messages/layer.messages'
import * as MH_Msgs from '@/messages/match-history.messages'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import * as L from '@/models/layer'
import type * as MH from '@/models/match-history.models'
import { useOpenOrFocusWindow } from '@/systems/draggable-window.client'
import { tr } from '@/systems/messages.client'

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/**
 * What one match was, for the `#id` badge an event row carries.
 *
 * The same facts the matches results table shows, in the same words, stacked. Reachable only while the
 * tooltip is pinned, which is what the layer link needs (see interactions.ts).
 */
export default function MatchTip(props: { details: MH.MatchDetails; displayTeamsNormalized: boolean }) {
	const { details } = props
	const openOrFocusWindow = useOpenOrFocusWindow()
	const time = MatchSummary.matchTime(details)
	const duration = MatchSummary.durationText(details)
	const outcome = MatchSummary.outcomeText(details)

	const result = [outcome, duration && tr.text(HistoryMsgs.matchTipMinutes(Number(duration)))].filter(Boolean)
	const meta = [details.serverId, time && dateTime.format(time), tr.text(HistoryMsgs.matchTipSetBy(details.layerSource.type))]

	return (
		<div className="flex flex-col gap-0.5">
			<div className="flex items-baseline gap-2">
				<Atoms.ShortLayerName
					normalized={props.displayTeamsNormalized}
					layerId={details.layerId}
					teamParity={details.ordinal % 2}
					// the top-right link is the one way in, so the name is not also a button
					allowShowInfo={false}
					className="font-semibold"
				/>
				<span className="font-mono text-muted-foreground">#{details.historyEntryId}</span>
				<button
					type="button"
					className="ml-auto inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-muted-foreground hover:text-foreground"
					disabled={!L.isKnownLayer(details.layerId)}
					onClick={() => openOrFocusWindow(WINDOW_ID.enum['layer-info'], { layerId: details.layerId, tab: 'details' })}
				>
					{tr.text(L_Msgs.showDetails())}
					<Icons.ExternalLink className="h-3 w-3" />
				</button>
			</div>
			<div className="text-muted-foreground">{result.length > 0 ? result.join(' · ') : tr.text(MH_Msgs.inProgress())}</div>
			<div className="text-muted-foreground">{meta.filter(Boolean).join(' · ')}</div>
		</div>
	)
}
