import ServerActivityPanel from '@/components/server-activity-panel'
import StatsPanel from '@/components/stats-panel'

export default function SecondaryPanel() {
	return (
		<div className="flex flex-col gap-2 h-full min-h-0 w-full max-w-[800px]">
			<div className="shrink-0 w-full">
				<StatsPanel />
			</div>
			<div className="flex-1 min-h-0 w-full">
				<ServerActivityPanel />
			</div>
		</div>
	)
}
