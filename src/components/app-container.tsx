import * as AR from '@/app-routes.ts'
import { Button } from '@/components/ui/button'
import * as ConfigClient from '@/systems.client/config.client'
import * as RbacClient from '@/systems.client/rbac.client'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import { useLoggedInUser } from '@/systems.client/users.client'
import { trpcConnectedAtom } from '@/trpc.client'
import { useAtomValue } from 'jotai'
import * as Icons from 'lucide-react'
import React from 'react'
import { Link } from 'react-router-dom'
import * as Zus from 'zustand'
import { ServerUnreachable } from './server-offline-display'
import { Alert, AlertTitle } from './ui/alert'
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from './ui/dropdown-menu'
import UserPermissionsDialog from './user-permissions-dialog'

export default function AppContainer(props: { children: React.ReactNode }) {
	const trpcConnected = useAtomValue(trpcConnectedAtom)
	const { simulateRoles, setSimulateRoles } = Zus.useStore(RbacClient.RbacStore)
	const serverInfoRes = SquadServerClient.useServerInfo()
	const user = useLoggedInUser()
	const avatarUrl = user?.avatar
		? `https://cdn.discordapp.com/avatars/${user.discordId}/${user.avatar}.png`
		: 'https://cdn.discordapp.com/embed/avatars/0.png'

	const [openState, setDropdownState] = React.useState<'primary' | 'permissions' | null>(null)
	const onPrimaryDropdownOpenChange = (newState: boolean) => {
		if (openState !== 'primary' && openState !== null) return
		setDropdownState(newState ? 'primary' : null)
	}
	const onPermissionsOpenChange = (newState: boolean) => {
		setDropdownState(newState ? 'permissions' : null)
	}
	const config = ConfigClient.useConfig()
	const primaryDropdownOpen = openState !== null
	const permissionsOpen = openState === 'permissions'
	return (
		<div className="h-full w-full">
			<nav
				className="flex h-16 items-center justify-between border-b px-2 sm:px-4"
				style={{ backgroundColor: config?.topBarColor ?? undefined }}
			>
				<div className="flex items-start space-x-3 sm:space-x-6">
					<Link to={AR.link('/')} className={`text-sm sm:text-base font-medium ${location.pathname === '/' ? 'underline' : ''}`}>
						Queue
					</Link>
					<Link
						to={AR.link('/filters')}
						className={`text-sm sm:text-base font-medium ${location.pathname === '/filters' ? 'underline' : ''}`}
					>
						Filters
					</Link>
				</div>
				<div className="flex h-max min-h-0 flex-row items-center space-x-1 sm:space-x-3 lg:space-x-6 overflow-hidden">
					{simulateRoles && (
						<div className="hidden sm:flex items-center space-x-1 flex-shrink-0">
							<span className="text-sm font-medium">Simulating Roles</span>{' '}
							<Button size="icon" variant="ghost" onClick={() => setSimulateRoles(false)}>
								<Icons.X className="h-4 w-4" />
							</Button>
						</div>
					)}
					{serverInfoRes?.code === 'ok' && (
						<>
							{trpcConnected === false && (
								<Alert variant="destructive" className="hidden md:flex items-center space-x-2 py-1 px-2">
									<AlertTitle className="text-xs font-medium">Websocket Disconnected</AlertTitle>
								</Alert>
							)}
							<h3 className="hidden sm:block text-sm sm:text-base font-medium truncate max-w-[120px] sm:max-w-[200px] lg:max-w-none">
								{serverInfoRes.data.name}
							</h3>
						</>
					)}
					{serverInfoRes?.code === 'err:rcon' && (
						<div className="hidden sm:block">
							<ServerUnreachable statusRes={serverInfoRes} />
						</div>
					)}
					{user && (
						<DropdownMenu modal={false} open={primaryDropdownOpen} onOpenChange={onPrimaryDropdownOpenChange}>
							<DropdownMenuTrigger asChild>
								<Avatar className="hover:cursor-pointer select-none h-8 w-8 sm:h-10 sm:w-10 flex-shrink-0">
									<AvatarImage src={avatarUrl} crossOrigin="anonymous" />
									<AvatarFallback className="text-xs sm:text-sm">{user.username.slice(0, 2).toUpperCase()}</AvatarFallback>
								</Avatar>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuLabel className="truncate max-w-[200px]">{user.username}</DropdownMenuLabel>
								{simulateRoles && (
									<DropdownMenuItem onClick={() => setSimulateRoles(false)} className="sm:hidden text-sm">
										<Icons.X className="mr-2 h-4 w-4" />
										Stop Simulating Roles
									</DropdownMenuItem>
								)}
								{trpcConnected === false && (
									<DropdownMenuItem disabled className="md:hidden text-destructive text-sm">
										<Icons.WifiOff className="mr-2 h-4 w-4" />
										Websocket Disconnected
									</DropdownMenuItem>
								)}
								<form action={AR.route('/logout')} method="POST">
									<DropdownMenuItem asChild>
										<button className="w-full text-sm" type="submit">
											<Icons.LogOut className="mr-2 h-4 w-4" />
											Log Out
										</button>
									</DropdownMenuItem>
								</form>
								<UserPermissionsDialog onOpenChange={onPermissionsOpenChange} open={permissionsOpen}>
									<DropdownMenuItem onClick={() => setDropdownState('permissions')} className="text-sm">
										<Icons.Shield className="mr-2 h-4 w-4" />
										Permissions
									</DropdownMenuItem>
								</UserPermissionsDialog>
							</DropdownMenuContent>
						</DropdownMenu>
					)}
				</div>
			</nav>
			<div className="flex flex-grow p-4">{props.children}</div>
		</div>
	)
}
