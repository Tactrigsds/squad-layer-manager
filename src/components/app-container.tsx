import { useServerInfo } from '@/hooks/use-server-info'
import * as DH from '@/lib/displayHelpers'
import * as Typography from '@/lib/typography'
import { cn } from '@/lib/utils'
import { GridIcon } from '@radix-ui/react-icons'
import { Link } from 'react-router-dom'

import { Separator } from './ui/separator'

export default function AppContainer(props: { children: React.ReactNode }) {
	const serverInfo = useServerInfo()
	return (
		<div className="">
			<nav className="flex items-center justify-between h-16 px-4 border-b">
				<div className="flex items-start space-x-6">
					<Link to="/" className={`flex items-center space-x-2 ${location.pathname === '/' ? 'underline' : ''}`}>
						<span className={Typography.Lead}>Queue</span>
					</Link>
					<Link to="/filters/edit" className={`${Typography.Lead} ${location.pathname === '/filters/edit' ? 'underline' : ''}`}>
						Edit filters
					</Link>
				</div>
				<div className="flex flex-row space-x-8 items-center min-h-0 h-max">
					{serverInfo && (
						<>
							<div className="flex flex-col">
								<div className={Typography.Small}>
									<span className="font-bold">{serverInfo.currentPlayers}</span> /{' '}
									<span className="font-bold">{serverInfo.maxPlayers}</span> players online
								</div>
								<div className={Typography.Small}>
									<span className="font-bold">{serverInfo.currentPlayersInQueue}</span> players in queue
								</div>
							</div>
							<div className="grid grid-cols-[auto_auto] h-full">
								<span className={cn(Typography.Small, 'mr-2')}>Now playing:</span>
								<span className={cn(Typography.Small, 'font-bold')}>{DH.toShortLayerName(serverInfo.currentLayer)}</span>
								<span className={cn(Typography.Small, 'mr-2')}>Next:</span>
								<span className={cn(Typography.Small, 'font-bold')}>{DH.toShortLayerName(serverInfo.nextLayer)}</span>
							</div>
						</>
					)}
				</div>
			</nav>
			<div className="w-full h-full p-4">{props.children}</div>
		</div>
	)
}
