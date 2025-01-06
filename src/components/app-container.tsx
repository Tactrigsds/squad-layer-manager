import { Link } from 'react-router-dom'

import * as AR from '@/app-routes.ts'
import { useSquadServerStatus } from '@/hooks/use-squad-server-status'
import * as DH from '@/lib/display-helpers.ts'
import * as Typography from '@/lib/typography'
import { cn } from '@/lib/utils'

import { Button } from './ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from './ui/dropdown-menu'
import { useLoggedInUser } from '@/hooks/use-logged-in-user'

export default function AppContainer(props: { children: React.ReactNode }) {
	const status = useSquadServerStatus()
	const userRes = useLoggedInUser()
	const avatarUrl = userRes.data
		? `https://cdn.discordapp.com/avatars/${userRes.data.discordId}/${userRes.data.avatar}.png`
		: 'https://cdn.discordapp.com/embed/avatars/0.png'
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
				<div className="flex h-max min-h-0 flex-row items-center space-x-6">
					{status && (
						<>
							<h3 className={Typography.H4}>{status.name}</h3>
							<div className="flex flex-col">
								<div className={Typography.Small}>
									<span className="font-bold">{status.playerCount}</span> / <span className="font-bold">{status.maxPlayerCount}</span>{' '}
									online
								</div>
								<div className={Typography.Small}>
									<span className="font-bold">{status.queueLength}</span> / <span className="font-bold">{status.maxQueueLength}</span> in
									queue
								</div>
							</div>
							<div className="grid h-full grid-cols-[auto_auto]">
								<span className={cn(Typography.Small, 'mr-2')}>Now playing:</span>
								<span className={cn(Typography.Small, 'font-bold')}>
									{status.currentLayer && DH.displayPossibleUnknownLayer(status.currentLayer)}
								</span>
								<span className={cn(Typography.Small, 'mr-2')}>Next:</span>
								<span className={cn(Typography.Small, 'font-bold')}>
									{status.nextLayer && DH.displayPossibleUnknownLayer(status.nextLayer)}
								</span>
							</div>
						</>
					)}
					{userRes.data && (
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="ghost" size="icon" className="rounded-full overflow-hidden">
									<img src={avatarUrl} alt="Discord Avatar" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent>
								<DropdownMenuLabel>{userRes.data.username}</DropdownMenuLabel>
								<form action={AR.exists('/logout')} method="POST">
									<DropdownMenuItem asChild>
										<button className="w-full" type="submit">
											Log Out
										</button>
									</DropdownMenuItem>
								</form>
							</DropdownMenuContent>
						</DropdownMenu>
					)}
				</div>
			</nav>
			<div className="flex flex-grow p-4">{props.children}</div>
		</div>
	)
}
