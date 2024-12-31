import { Link } from 'react-router-dom'

import * as AR from '@/app-routes.ts'
import { useSquadServerStatus } from '@/hooks/server-state.ts'
import * as DH from '@/lib/display-helpers.ts'
import { trpcReact } from '@/lib/trpc.client.ts'
import * as Typography from '@/lib/typography'
import { cn } from '@/lib/utils'

import { Button, buttonVariants } from './ui/button'

export default function AppContainer(props: { children: React.ReactNode }) {
	const status = useSquadServerStatus()
	const userRes = trpcReact.getLoggedInUser.useQuery()
	return (
		<div className="h-full w-full">
			<nav className="flex h-16 items-center justify-between border-b px-4">
				<div className="flex items-start space-x-6">
					<Link to={AR.link('/')} className={`flex items-center space-x-2 ${location.pathname === '/' ? 'underline' : ''}`}>
						<span className={Typography.Lead}>Queue</span>
					</Link>
					<Link to={AR.link('/filters')} className={`${Typography.Lead} ${location.pathname === '/filters' ? 'underline' : ''}`}>
						Filters
					</Link>
				</div>
				<div className="flex h-max min-h-0 flex-row items-center space-x-8">
					<>
						{status && (
							<div className="flex flex-col">
								<div className={Typography.Small}>
									<span className="font-bold">{status.currentPlayers}</span> / <span className="font-bold">{status.maxPlayers}</span>{' '}
									players online
								</div>
							</div>
						)}
						<div className="grid h-full grid-cols-[auto_auto]">
							<span className={cn(Typography.Small, 'mr-2')}>Now playing:</span>
							<span className={cn(Typography.Small, 'font-bold')}>{status?.currentLayer && DH.toShortLayerName(status?.currentLayer)}</span>
							<span className={cn(Typography.Small, 'mr-2')}>Next:</span>
							<span className={cn(Typography.Small, 'font-bold')}>{status?.nextLayer && DH.toShortLayerName(status?.nextLayer)}</span>
						</div>
					</>
					{userRes.data && (
						<div className="flex flex-row items-center space-x-4">
							<span className={Typography.Small}>Logged in as {userRes.data.username}</span>
							<form action={AR.exists('/logout')} method="POST">
								<Button
									type="submit"
									className={buttonVariants({
										variant: 'secondary',
										size: 'sm',
									})}
								>
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
