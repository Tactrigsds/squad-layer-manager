import * as Icons from 'lucide-react'
import React from 'react'

import type { SquadDetailsWindowProps } from '@/components/squad-details-window.helpers'
import { StatsSortOptions } from '@/components/stats-sort-options'
import { statMetricLabel } from '@/components/stats-sort-options.helpers'
import {
	FILTER_ALL,
	type FilterOption,
	sameFilterOptions,
	STATS_HEADING_LETTERS,
	type StatsSortState,
} from '@/components/teams-panel/teams-panel.helpers'
import { Checkbox } from '@/components/ui/checkbox'
import { OpenWindowInteraction } from '@/components/ui/draggable-window'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import * as TeamsPanelPrt from '@/frame-partials/teams-panel.partial'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import { cn } from '@/lib/utils.ts'
import * as Zus from '@/lib/zustand'
import * as SM_Msgs from '@/messages/squad.messages'
import * as SRQ_Msgs from '@/messages/switch-requests.messages'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import type * as SM from '@/models/squad.models'
import { tr } from '@/systems/messages.client'
import * as SRQClient from '@/systems/switch-requests.client'
import * as TSWClient from '@/systems/teamswaps.client'

export function SelectOrSpinner({
	playerId,
	checked,
	onCheckedChange,
	stores,
}: {
	playerId: SM.PlayerId
	checked: boolean
	onCheckedChange: (checked: boolean) => void
	stores: SquadServerFrame.KeyProp
}) {
	const isPending = Zus.useStore(stores.squadServer!, TSWClient.Sel.isSwapPending(playerId))
	return (
		<div className="flex size-(--cbx) shrink-0 items-center justify-center">
			{isPending ? (
				<Icons.LoaderCircle className="h-3 w-3 animate-spin text-muted-foreground" />
			) : (
				<Checkbox checked={checked} onCheckedChange={onCheckedChange} aria-label={tr.text(SM_Msgs.selectRow())} />
			)}
		</div>
	)
}

// the amber arrows beside a name: this player asked to switch teams (/switch). Rendered per-row so only queued
// rows subscribe-and-rerender when the queue changes.
export function SwitchRequestIcon({
	playerId,
	teamId,
	stores,
}: {
	playerId: SM.PlayerId
	teamId: SM.TeamId | null
	stores: SquadServerFrame.KeyProp
}) {
	const queued = Zus.useStore(stores.squadServer!, SRQClient.Sel.isQueued(playerId))
	if (!queued) return null
	return (
		<span
			title={tr.text(SRQ_Msgs.iconHint())}
			onClickCapture={(e) => {
				if (!e.shiftKey) return
				e.preventDefault()
				e.stopPropagation()
				SquadServerFrame.Actions.selectAllSwitchRequesters(stores, e.ctrlKey ? undefined : (teamId ?? undefined))
			}}
		>
			<Icons.ArrowLeftRight className="h-3 w-3 text-warn shrink-0" />
		</span>
	)
}

function ColumnFilterSelectView({
	value,
	options,
	column,
	teamsPanel,
	squadFilterTarget,
	triggerClassName,
}: {
	value: string | null
	options: FilterOption[]
	column: TeamsPanelPrt.FilterColumn
	teamsPanel: TeamsPanelPrt.Key
	// only the squad column reads it
	squadFilterTarget: TeamsPanelPrt.SquadFilterTarget
	triggerClassName?: string
}) {
	if (options.length === 0) return null
	return (
		<Select
			value={value ?? FILTER_ALL}
			onValueChange={(v) =>
				TeamsPanelPrt.Actions.setColumnFilter({ teamsPanel }, squadFilterTarget, column, v === FILTER_ALL ? null : v)
			}
		>
			<SelectTrigger
				onClick={(e) => e.stopPropagation()}
				className={cn(
					'h-4 max-phone:h-(--ctl-sm) max-phone:px-1.5 w-auto gap-0.5 bg-transparent px-0 py-0 text-2xs font-normal normal-case tracking-normal shadow-none [&>svg]:size-2.5',
					triggerClassName,
					value ? 'text-pri-hi font-semibold' : 'text-text-3',
				)}
			>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value={FILTER_ALL}>{tr.text(SM_Msgs.allGroupings())}</SelectItem>
				{options.map((o) => (
					<SelectItem key={o.value} value={o.value}>
						{o.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	)
}

// A closed radix Select still renders every item, to read the selected one's text. The headers re-render with every
// roster change, so the options are compared by content rather than by the array rebuilt each time.
export const ColumnFilterSelect = React.memo(
	ColumnFilterSelectView,
	(prev, next) =>
		prev.value === next.value &&
		prev.column === next.column &&
		prev.teamsPanel === next.teamsPanel &&
		prev.squadFilterTarget === next.squadFilterTarget &&
		prev.triggerClassName === next.triggerClassName &&
		sameFilterOptions(prev.options, next.options),
)

export function StatsColumnHeader({ statsSort, mayBeInaccurate }: { statsSort: StatsSortState; mayBeInaccurate: boolean }) {
	const { metric, scope, dir, open, setOpen } = statsSort
	const metricLabel = tr.text(statMetricLabel(metric))
	// a lit letter names a player sort by kills, wounds or deaths; any other stats sort lights the whole heading
	const wholeHeadingLit = scope === 'squads' || (scope === 'players' && (metric === 'kd' || metric === 'wd'))
	return (
		<span className="inline-flex items-center gap-1">
			{mayBeInaccurate && (
				<Tooltip>
					<TooltipTrigger asChild>
						<Icons.AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0" />
					</TooltipTrigger>
					<TooltipContent className="max-w-[220px]">{tr.text(SM_Msgs.statsMayBeInaccurate())}</TooltipContent>
				</Tooltip>
			)}
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<button
						type="button"
						data-tour="players-stats-sort"
						onClick={(e) => e.stopPropagation()}
						className="inline-flex items-center"
						title={tr.text(
							scope ? SM_Msgs.sortedByStat(tr.text(SM_Msgs.statsSortLabel(scope, metricLabel))) : SM_Msgs.sortByStatsHint(),
						)}
					>
						<span className={wholeHeadingLit ? 'text-primary font-semibold' : undefined}>
							{STATS_HEADING_LETTERS.map(({ metric: m, short }, i) => (
								<React.Fragment key={m}>
									{i > 0 && <span className="text-muted-foreground">/</span>}
									<span className={scope === 'players' && metric === m ? 'text-primary font-semibold' : undefined}>
										{tr.text(short())}
									</span>
								</React.Fragment>
							))}
						</span>
						{wholeHeadingLit && scope && (
							<span className="ms-1 text-primary font-semibold">{tr.text(SM_Msgs.statsSortLabel(scope, metricLabel))}</span>
						)}
						<Icons.ArrowUpDown className="ms-1 h-3 w-3 text-muted-foreground" />
					</button>
				</PopoverTrigger>
				<PopoverContent side="top" align="start" className="w-auto max-w-80 p-1" onClick={(e) => e.stopPropagation()}>
					<StatsSortOptions
						scope={scope}
						sortKey={metric}
						desc={dir !== 'asc'}
						onPick={(pick) => statsSort.set({ scope: pick.scope, metric: pick.key, desc: pick.desc })}
						onClear={() => {
							statsSort.clear()
							setOpen(false)
						}}
					/>
				</PopoverContent>
			</Popover>
		</span>
	)
}

// module-level render prop so its identity is stable across renders
function squadButton({
	label,
	ref,
	onClick,
	...rest
}: {
	label: string
	ref?: React.Ref<HTMLButtonElement>
	onClick?: React.MouseEventHandler<HTMLButtonElement>
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
	return (
		<button
			ref={ref}
			type="button"
			className="hover:underline cursor-pointer"
			onClick={(e) => {
				e.stopPropagation()
				onClick?.(e)
			}}
			{...rest}
		>
			{label}
		</button>
	)
}

// Renders a squad label (command squads are plain text, others open the squad-details window) that opens the
// squad context menu (see RowMenuTarget). `label` is precomputed by the caller so the two variants can format it
// differently (e.g. "12" vs "USA:12").
export function SquadCell({
	squad,
	label,
	isLeader,
	teamId,
	stores,
}: {
	squad: SM.UniqueSquad
	label: string
	isLeader: boolean
	teamId?: SM.TeamId
	stores: SquadServerFrame.KeyProp
}) {
	const isCmd = squad.squadName === 'Command Squad'
	const squadLabel = isCmd ? (
		<span>{label}</span>
	) : (
		<OpenWindowInteraction
			windowId={WINDOW_ID.enum['squad-details']}
			windowProps={{ uniqueSquadId: squad.uniqueId, stores } satisfies SquadDetailsWindowProps}
			preload="intent"
			render={squadButton}
			label={label}
		/>
	)
	return (
		<span className="inline-flex items-center gap-1">
			<span data-squad-menu={squad.uniqueId}>{squadLabel}</span>
			{isLeader && (
				<span
					data-select-squad-leaders
					className="text-xs text-muted-foreground hover:text-primary hover:underline cursor-pointer"
					title={tr.text(SM_Msgs.squadLeaderColumnHint())}
					onClickCapture={(e) => {
						if (!e.shiftKey) return
						e.preventDefault()
						e.stopPropagation()
						SquadServerFrame.Actions.selectAllSquadLeaders(stores, e.ctrlKey ? undefined : teamId)
					}}
				>
					{tr.text(SM_Msgs.squadLeaderMarker())}
				</span>
			)}
		</span>
	)
}
