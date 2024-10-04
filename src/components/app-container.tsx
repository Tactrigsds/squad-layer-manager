import * as DH from '@/displayHelpers'
import { useServerInfo } from '@/hooks/use-server-info'
import { trpc } from '@/lib/trpc'
import { GridIcon } from '@radix-ui/react-icons'

export default function AppContainer(props: { children: React.ReactNode }) {
	const serverInfo = useServerInfo()
	return (
		<div className="">
			<nav className="flex items-center justify-between h-16 px-4 border-b">
				<div className="flex items-start">
					<GridIcon />
				</div>
				<div className="flex flex-row space-x-2 items-center">
					{serverInfo && (
						<>
							<div>
								{serverInfo.currentPlayers} / {serverInfo.maxPlayers}
							</div>
							<div className="grid grid-cols-[auto_auto]">
								<span className="mr-2">Now playing:</span>
								<span>{DH.toShortLayerName(serverInfo.currentLayer)}</span>
								<span className="mr-2">Next:</span>
								<span> {DH.toShortLayerName(serverInfo.nextLayer)}</span>
							</div>
						</>
					)}
				</div>
			</nav>
			{props.children}
		</div>
	)
}
