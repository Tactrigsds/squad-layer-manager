import * as AR from '@/app-routes.ts'
import AboutDialog from '@/components/about-dialog'
import CommandsHelpDialog from '@/components/commands-help-dialog'
import NicknameDialog from '@/components/nickname-dialog'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Spinner } from '@/components/ui/spinner'
import UserPermissionsDialog from '@/components/user-permissions-dialog'
import { cn } from '@/lib/utils'
import * as USR from '@/models/users.models.ts'
import * as RPC from '@/orpc.client'
import * as ConfigClient from '@/systems.client/config.client'
import * as FeatureFlags from '@/systems.client/feature-flags'
import * as LayerQueriesClient from '@/systems.client/layer-queries.client.ts'
import * as RbacClient from '@/systems.client/rbac.client'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import * as ThemeClient from '@/systems.client/theme'
import { useLoggedInUser } from '@/systems.client/users.client'
import { createFileRoute, Link, Outlet } from '@tanstack/react-router'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'

export const Route = createFileRoute('/_app')({
	loader: () => {
		void LayerQueriesClient.ensureFullSetup()
	},
	component: RouteComponent,
})

function RouteComponent() {
	const flags = FeatureFlags.useFeatureFlags()
	const wsStatus = RPC.useConnectStatus()
	const { simulateRoles, setSimulateRoles } = Zus.useStore(RbacClient.RbacStore)
	const user = useLoggedInUser()

	const avatarUrl = user && USR.getAvatarUrl(user)

	const [openState, setDropdownState] = React.useState<'primary' | 'permissions' | 'commands' | 'steam-link' | 'nickname' | 'about' | null>(
		null,
	)
	const onPrimaryDropdownOpenChange = (newState: boolean) => {
		if (openState !== 'primary' && openState !== null) return
		setDropdownState(newState ? 'primary' : null)
	}
	const onPermissionsOpenChange = (newState: boolean) => {
		setDropdownState(newState ? 'permissions' : null)
	}
	const onCommandsHelpOpenChange = (newState: boolean) => {
		setDropdownState(newState ? 'commands' : null)
	}

	const onNicknameOpenChange = (newState: boolean) => {
		setDropdownState(newState ? 'nickname' : null)
	}

	const onAboutOpenChange = (newState: boolean) => {
		setDropdownState(newState ? 'about' : null)
	}

	const { theme, setTheme } = ThemeClient.useTheme()
	const config = ConfigClient.useConfig()
	const selectedServerId = SquadServerClient.useSelectedServerId()
	const selectedServer = config?.servers.find(server => server.id === selectedServerId)
	return (
		<div className="h-full w-full">
			<nav
				className="flex h-16 items-center justify-between border-b px-2 sm:px-4"
				style={{ backgroundColor: config?.topBarColor ?? undefined }}
			>
				<div className="flex items-start space-x-3 sm:space-x-6">
					<NavLink
						params={{ serverId: selectedServerId }}
						to="/servers/$serverId"
					>
						Server
					</NavLink>
					<NavLink to="/filters">
						Filters
					</NavLink>
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

					{wsStatus === 'closed' && (
						<Alert variant="destructive" className="hidden w-max md:flex items-center space-x-2 py-1 px-2">
							<AlertTitle className="text-xs font-medium">WebSocket Disconnected</AlertTitle>
						</Alert>
					)}
					{(wsStatus === 'reconnecting' || wsStatus === 'pending') && (
						<div title="Connecting to server...">
							<Spinner />
						</div>
					)}
					{flags.displayWsClientId && config && (
						<span
							className="text-xs cursor-pointer"
							onClick={() => navigator.clipboard.writeText(config.wsClientId)}
						>
							{config.wsClientId}
						</span>
					)}
					{selectedServer && config && (config.servers.length === 1
						? <div className="font-medium text-sm">{selectedServer.displayName}</div>
						: (
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button variant="outline">
										{selectedServer.displayName}
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent>
									{config.servers.filter((server) => server.id !== selectedServer.id).map((server) => (
										<DropdownMenuItem asChild key={server.id}>
											<Link to="/servers/$serverId" params={{ serverId: server.id }}>
												{server.displayName}
											</Link>
										</DropdownMenuItem>
									))}
								</DropdownMenuContent>
							</DropdownMenu>
						))}
					{user && (
						<DropdownMenu modal={false} open={openState !== null} onOpenChange={onPrimaryDropdownOpenChange}>
							<DropdownMenuTrigger asChild>
								<Avatar
									style={{ backgroundColor: user.displayHexColor ?? undefined }}
									className="hover:cursor-pointer select-none h-8 w-8 sm:h-10 sm:w-10 flex-shrink-0"
								>
									<AvatarImage src={avatarUrl} crossOrigin="anonymous" />
									<AvatarFallback className="text-xs sm:text-sm">{user.displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
								</Avatar>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuLabel className="truncate max-w-[200px]">{user.displayName}</DropdownMenuLabel>
								{simulateRoles && (
									<DropdownMenuItem onClick={() => setSimulateRoles(false)} className="sm:hidden text-sm">
										<Icons.X className="mr-2 h-4 w-4" />
										Stop Simulating Roles
									</DropdownMenuItem>
								)}
								{wsStatus === 'closed' && (
									<DropdownMenuItem disabled className="md:hidden text-destructive text-sm">
										<Icons.WifiOff className="mr-2 h-4 w-4" />
										Websocket Disconnected
									</DropdownMenuItem>
								)}
								<DropdownMenuSub>
									<DropdownMenuSubTrigger className="text-sm" chevronLeft>
										Theme
									</DropdownMenuSubTrigger>
									<DropdownMenuSubContent>
										<DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as 'dark' | 'light' | 'system')}>
											<DropdownMenuRadioItem value="light" className="text-sm">
												<Icons.Sun className="mr-2 h-4 w-4" />
												Light
											</DropdownMenuRadioItem>
											<DropdownMenuRadioItem value="dark" className="text-sm">
												<Icons.Moon className="mr-2 h-4 w-4" />
												Dark
											</DropdownMenuRadioItem>
											<DropdownMenuRadioItem value="system" className="text-sm">
												<Icons.Monitor className="mr-2 h-4 w-4" />
												System
											</DropdownMenuRadioItem>
										</DropdownMenuRadioGroup>
									</DropdownMenuSubContent>
								</DropdownMenuSub>
								<DropdownMenuSeparator />
								<NicknameDialog onOpenChange={onNicknameOpenChange} open={openState === 'nickname'}>
									<DropdownMenuItem onClick={() => setDropdownState('nickname')} className="text-sm">
										<Icons.User className="mr-2 h-4 w-4" />
										Set Nickname
									</DropdownMenuItem>
								</NicknameDialog>
								<UserPermissionsDialog onOpenChange={onPermissionsOpenChange} open={openState === 'permissions'}>
									<DropdownMenuItem onClick={() => setDropdownState('permissions')} className="text-sm">
										<Icons.Shield className="mr-2 h-4 w-4" />
										Permissions
									</DropdownMenuItem>
								</UserPermissionsDialog>
								<CommandsHelpDialog onOpenChange={onCommandsHelpOpenChange} open={openState === 'commands'}>
									<DropdownMenuItem onClick={() => setDropdownState('commands')} className="text-sm">
										<Icons.HelpCircle className="mr-2 h-4 w-4" />
										Commands
									</DropdownMenuItem>
								</CommandsHelpDialog>
								<AboutDialog onOpenChange={onAboutOpenChange} open={openState === 'about'}>
									<DropdownMenuItem onClick={() => setDropdownState('about')} className="text-sm">
										<Icons.Info className="mr-2 h-4 w-4" />
										About
									</DropdownMenuItem>
								</AboutDialog>
								<DropdownMenuSeparator />
								<form action={AR.route('/logout')} method="POST">
									<DropdownMenuItem asChild>
										<button className="w-full text-sm" type="submit">
											<Icons.LogOut className="mr-2 h-4 w-4" />
											Log Out
										</button>
									</DropdownMenuItem>
								</form>
								{
									/*<LinkSteamAccountDialog onOpenChange={onSteamLinkOpenChange} open={openState === 'steam-link'}>
									<DropdownMenuItem onClick={() => setDropdownState('steam-link')} className="text-sm">
										<Icons.Link className="mr-2 h-4 w-4" />
										Linked Accounts
									</DropdownMenuItem>
								</LinkSteamAccountDialog>*/
								}
							</DropdownMenuContent>
						</DropdownMenu>
					)}
				</div>
			</nav>
			<div className="flex flex-grow p-4">
				<Outlet />
			</div>
		</div>
	)
}

const NavLink: typeof Link = (props) => {
	const baseClasses = 'text-sm sm:text-base font-medium'
	return (
		<Link
			activeProps={{ className: cn(`${baseClasses} font-bold`, props.className) }}
			preload="intent"
			className={cn(baseClasses, props.className)}
			{...props}
		>
			{props.children}
		</Link>
	)
}
