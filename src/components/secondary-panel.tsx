import ServerActivityPanel from '@/components/server-activity-panel'
import StatsPanel from '@/components/stats-panel'
import type * as SquadServerFrame from '@/frames/squad-server.frame'

export default function SecondaryPanel(props: { stores: SquadServerFrame.KeyProp }) {
	return (
		<div className="flex flex-col gap-2 h-full min-h-0 w-full max-w-[800px]">
			<div className="shrink-0 w-full">
				<StatsPanel stores={props.stores} />
			</div>
			<div className="flex-1 min-h-0 w-full">
				<ServerActivityPanel stores={props.stores} />
			</div>
		</div>
	)
}
