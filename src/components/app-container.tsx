import * as AR from '@/app-routes.ts'
import { useServerInfo } from '@/hooks/use-server-info'
import * as DH from '@/lib/display-helpers'
import { trpcReact } from '@/lib/trpc.client.ts'
import * as Typography from '@/lib/typography'
import { cn } from '@/lib/utils'
import { Link } from 'react-router-dom'

import { Button, buttonVariants } from './ui/button'

export default function AppContainer(props: { children: React.ReactNode }) {
	const serverInfo = useServerInfo()
	const userRes = trpcReact.getLoggedInUser.useQuery()
	return (
		<div className="w-full h-full">
			<nav className="flex items-center justify-between h-16 px-4 border-b">
				<div className="flex items-start space-x-6">
					<Link to={AR.link('/', [])} className={`flex items-center space-x-2 ${location.pathname === '/' ? 'underline' : ''}`}>
						<span className={Typography.Lead}>Queue</span>
					</Link>
					<Link to={AR.link('/filters', [])} className={`${Typography.Lead} ${location.pathname === '/filters' ? 'underline' : ''}`}>
						Filters
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
					{userRes.data && (
						<div className="flex flex-row items-center space-x-4">
							<span className={Typography.Small}>Logged in as {userRes.data.username}</span>
							<form action={AR.exists('/logout')} method="POST">
								<Button type="submit" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
									Log Out
								</Button>
							</form>
						</div>
					)}
				</div>
			</nav>
			<div className="flex flex-grow p-4">{props.children}</div>
		</div>
	)
}
