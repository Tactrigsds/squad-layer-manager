import * as AR from '@/app-routes.ts'
import AboutDialog from '@/components/about-dialog'
import CommandsHelpDialog from '@/components/commands-help-dialog'
import LinkSteamAccountDialog from '@/components/link-steam-account-dialog'
import NicknameDialog from '@/components/nickname-dialog'
import SelectLayersDialog from '@/components/select-layers-dialog'
import { ServerActionsDropdown } from '@/components/server-actions-dropdown'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Spinner } from '@/components/ui/spinner'
import TabsList from '@/components/ui/tabs-list'
import UserPermissionsDialog from '@/components/user-permissions-dialog'
import { frameManager } from '@/frames/frame-manager.ts'

import * as SquadServerFrame from '@/frames/squad-server.frame.ts'

import { useIsDesktopSize, useIsSmallViewport } from '@/lib/browser.ts'
import { cn } from '@/lib/utils'
import * as ZusUtils from '@/lib/zustand'
import * as USR from '@/models/users.models.ts'
import * as RPC from '@/orpc.client'
import * as RBAC from '@/rbac.models'
import * as ConfigClient from '@/systems/config.client'
import * as FeatureFlags from '@/systems/feature-flags.client'

import * as RbacClient from '@/systems/rbac.client'
import * as SettingsClient from '@/systems/settings.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as ThemeClient from '@/systems/theme.client'
import { useLoggedInUser } from '@/systems/users.client'
import * as TSR from '@tanstack/react-router'
import * as Icons from 'lucide-react'
import React from 'react'

export default function NavBar() {
	const flags = FeatureFlags.useFeatureFlags()
	const wsStatus = RPC.useConnectStatus()
	const { simulateRoles, setSimulateRoles } = ZusUtils.useStore(RbacClient.RbacStore)
	const user = useLoggedInUser()

	const avatarUrl = user && USR.getAvatarUrl(user)

	// Check if we're on the server dashboard route
	const isOnServerDashboard = TSR.useMatch({ from: '/_app/servers/$serverId', shouldThrow: false })
	const isDesktop = useIsDesktopSize()
	// below sm the nav links + user-avatar options all collapse into a single hamburger menu
	const isSmall = useIsSmallViewport()
	const activeDashboardTab = ZusUtils.useStore(SquadServerClient.DashboardTabStore, s => s.activeTab)
	// in single-column mode the dashboard has no room for its own tab cluster, so the switcher takes over the "Server" nav slot
	const showDashboardTabs = !!isOnServerDashboard && !isDesktop

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

	const onSteamLinkOpenChange = (newState: boolean) => {
		setDropdownState(newState ? 'steam-link' : null)
	}

	const onAboutOpenChange = (newState: boolean) => {
		setDropdownState(newState ? 'about' : null)
	}

	const { theme, setTheme } = ThemeClient.useTheme()
	const config = ZusUtils.useStore(ConfigClient.Store)
	const settings = ZusUtils.useStore(SettingsClient.PublicSettingsStore)
	const selectedServerId = ZusUtils.useStore(SquadServerClient.SelectedServerStore, s => s.selectedServerId)
	const selectedServer = settings?.servers.find(server => server.id === selectedServerId)
	// NavBar isn't a descendant of the servers/$serverId route, so it can't receive the frame via props --
	// ensureSetup just dedupes onto the instance the route already created. Only set up a frame for a usable server;
	// building one for a disabled/missing server would spam subscription errors against a slice that doesn't exist.
	const squadServerKey = React.useMemo(
		() =>
			SettingsClient.isServerUsable(selectedServer)
				? frameManager.ensureSetup(SquadServerFrame.frame, SquadServerFrame.createInput(selectedServer.id))
				: undefined,
		[selectedServer],
	)

	const registryDenied = RbacClient.usePermsCheck({
		check: 'any',
		permits: [RBAC.perm('admin:manage-servers'), RBAC.perm('admin:delete-servers')],
	})
	const loggedInPerms = RbacClient.useLoggedInPerms()
	const showSettingsLink = !registryDenied
		|| RBAC.canReadGlobalSettings(loggedInPerms)
		|| (settings?.servers ?? []).some((s) => RBAC.canReadServerSettings(loggedInPerms, s.id))
	const [exploreLayersOpen, setExploreLayersOpen] = React.useState(false)

	// the user-avatar menu items, shared between the avatar dropdown (>= sm) and the hamburger (< sm). Rendered in exactly one
	// of those two places (gated by isSmall) so the controlled dialogs below aren't mounted twice.
	const userMenuContent = user && (
		<>
			<DropdownMenuLabel className="truncate max-w-50">{user.displayName}</DropdownMenuLabel>
			{simulateRoles && (
				<DropdownMenuItem onClick={() => setSimulateRoles(false)} className="sm:hidden text-sm">
					<Icons.X className="mr-2 h-4 w-4" />
					Stop Simulating Roles
				</DropdownMenuItem>
			)}
			{wsStatus === 'closed' && (
				<DropdownMenuItem disabled className="md:hidden text-destructive text-sm">
					<span className="flex space-x-2 items-center">
						<Spinner className="h-4 w-4" />
						<AlertTitle className="text-xs font-medium">Disconnected from server</AlertTitle>
					</span>
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
			<LinkSteamAccountDialog onOpenChange={onSteamLinkOpenChange} open={openState === 'steam-link'}>
				<DropdownMenuItem onClick={() => setDropdownState('steam-link')} className="text-sm">
					<Icons.Link className="mr-2 h-4 w-4" />
					Linked Steam Accounts
				</DropdownMenuItem>
			</LinkSteamAccountDialog>
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
		</>
	)

	return (
		<nav
			className="flex h-16 shrink-0 items-center justify-between border-b px-2 sm:px-4"
			style={{ backgroundColor: settings?.topBarColor ?? undefined }}
		>
			<div className="flex items-center space-x-3 sm:space-x-6">
				{/* below sm the nav links (and the avatar menu) don't fit, so collapse them into one hamburger; tabs stay beside it */}
				{isSmall && (
					<MobileNavMenu
						open={openState !== null}
						onOpenChange={onPrimaryDropdownOpenChange}
						showServerLink={!showDashboardTabs}
						selectedServerId={selectedServer?.id}
						showSettingsLink={showSettingsLink}
						onExploreLayers={() => setExploreLayersOpen(true)}
					>
						{userMenuContent}
					</MobileNavMenu>
				)}
				{/* on the dashboard's single-column layout the tab switcher takes over the "Server" nav slot at every width */}
				{showDashboardTabs && (
					<TabsList
						options={[
							{ value: 'layers', label: 'Layers & Teams' },
							{ value: 'secondary', label: 'Server Activity' },
						]}
						active={activeDashboardTab}
						setActive={SquadServerClient.DashboardTabActions.setActiveTab}
					/>
				)}
				{!isSmall && (
					<div className="flex items-center space-x-3 sm:space-x-6">
						{/* the tab switcher already covers "Server" in single-column mode, so only show the link when tabs aren't shown */}
						{!showDashboardTabs && (
							selectedServer
								? <NavLink params={{ serverId: selectedServer.id }} to="/servers/$serverId">Server</NavLink>
								: <NavLink to="/servers">Server</NavLink>
						)}
						<NavLink to="/filters">Filters</NavLink>
						{showSettingsLink && <NavLink to="/settings">Settings</NavLink>}
						<Button variant="secondary" size="sm" onClick={() => setExploreLayersOpen(true)}>Explore Layers</Button>
					</div>
				)}
			</div>
			<ExploreLayersDialog open={exploreLayersOpen} onOpenChange={setExploreLayersOpen} />
			<div className="flex h-max min-h-0 flex-row items-center space-x-1 sm:space-x-3 overflow-hidden">
				{simulateRoles && (
					<div className="hidden sm:flex items-center space-x-1 shrink-0">
						<span className="text-sm font-medium">Simulating Roles</span>{' '}
						<Button size="icon" variant="ghost" onClick={() => setSimulateRoles(false)}>
							<Icons.X className="h-4 w-4" />
						</Button>
					</div>
				)}

				{wsStatus === 'closed' && (
					<Alert variant="destructive" className="hidden md:flex space-x-2 py-1 px-2">
						<span className="flex space-x-2 items-center">
							<Spinner className="h-4 w-4" />
							<AlertTitle className="text-xs font-medium">Disconnected from server</AlertTitle>
						</span>
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
				{isOnServerDashboard && squadServerKey && <ServerActionsDropdown stores={{ squadServer: squadServerKey }} />}
				{settings && <NavLinksDropdown globalLinks={settings.navLinks} />}
				{isOnServerDashboard && selectedServer && settings && (() => {
					const servers = settings.servers
					return servers.length <= 1
						? <div className="font-medium text-sm">{selectedServer.displayName}</div>
						: (
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button variant="outline">
										{selectedServer.displayName}
										<Icons.ChevronDown className="ml-2 h-4 w-4" />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="start" className="min-w-[--radix-dropdown-menu-trigger-width] ">
									{servers.filter(server => server.id !== selectedServer.id).map((server) => (
										<DropdownMenuItem className="cursor-pointer" asChild key={server.id}>
											<TSR.Link disabled={!server.enabled || server.broken} to="/servers/$serverId" params={{ serverId: server.id }}>
												{server.displayName} <Icons.Dot className={cn(server.enabled ? 'text-green-500' : 'text-red-500')} />
											</TSR.Link>
										</DropdownMenuItem>
									))}
								</DropdownMenuContent>
							</DropdownMenu>
						)
				})()}
				{user && (
					// below sm the avatar's options live in the hamburger, so the avatar is just a (non-interactive) identity marker
					isSmall
						? (
							<Avatar
								style={{ backgroundColor: user.displayHexColor ?? undefined }}
								className="select-none h-8 w-8 shrink-0"
							>
								<AvatarImage src={avatarUrl} crossOrigin="anonymous" />
								<AvatarFallback className="text-xs">{user.displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
							</Avatar>
						)
						: (
							<DropdownMenu modal={false} open={openState !== null} onOpenChange={onPrimaryDropdownOpenChange}>
								<DropdownMenuTrigger asChild>
									<Avatar
										style={{ backgroundColor: user.displayHexColor ?? undefined }}
										className="hover:cursor-pointer select-none h-8 w-8 sm:h-10 sm:w-10 shrink-0"
									>
										<AvatarImage src={avatarUrl} crossOrigin="anonymous" />
										<AvatarFallback className="text-xs sm:text-sm">{user.displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
									</Avatar>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									{userMenuContent}
								</DropdownMenuContent>
							</DropdownMenu>
						)
				)}
			</div>
		</nav>
	)
}

function ExploreLayersDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const data = TSR.useLoaderData({ from: '/_app' })

	return (
		<SelectLayersDialog
			stores={{ selectLayers: data.stores.exploreLayers }}
			open={props.open}
			onOpenChange={props.onOpenChange}
			title="Layers"
			pinMode="layers"
		/>
	)
}

// below sm the primary nav links AND the user-avatar options collapse into this one hamburger menu; the dashboard tab
// switcher stays inline beside it. Controlled by the shared openState so the appended user-menu dialogs keep it open.
function MobileNavMenu(props: {
	open: boolean
	onOpenChange: (open: boolean) => void
	showServerLink: boolean
	selectedServerId?: string
	showSettingsLink: boolean
	onExploreLayers: () => void
	children?: React.ReactNode
}) {
	return (
		<DropdownMenu modal={false} open={props.open} onOpenChange={props.onOpenChange}>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="icon" className="shrink-0">
					<Icons.Menu className="h-5 w-5" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start">
				{props.showServerLink && (
					<DropdownMenuItem asChild className="cursor-pointer">
						{props.selectedServerId
							? <TSR.Link to="/servers/$serverId" params={{ serverId: props.selectedServerId }}>Server</TSR.Link>
							: <TSR.Link to="/servers">Server</TSR.Link>}
					</DropdownMenuItem>
				)}
				<DropdownMenuItem asChild className="cursor-pointer">
					<TSR.Link to="/filters">Filters</TSR.Link>
				</DropdownMenuItem>
				{props.showSettingsLink && (
					<DropdownMenuItem asChild className="cursor-pointer">
						<TSR.Link to="/settings">Settings</TSR.Link>
					</DropdownMenuItem>
				)}
				<DropdownMenuItem className="cursor-pointer" onClick={props.onExploreLayers}>
					Explore Layers
				</DropdownMenuItem>
				{props.children && (
					<>
						<DropdownMenuSeparator />
						{props.children}
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function NavLinksDropdown(
	{ globalLinks, serverLinks }: { globalLinks?: { label: string; url: string }[]; serverLinks?: { label: string; url: string }[] },
) {
	const hasGlobal = globalLinks && globalLinks.length > 0
	const hasServer = serverLinks && serverLinks.length > 0
	if (!hasGlobal && !hasServer) return null

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="icon" className="shrink-0">
					<Icons.Link2 className="h-4 w-4" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{hasGlobal && globalLinks.map((link) => (
					<DropdownMenuItem key={link.url} asChild className="cursor-pointer">
						<a href={link.url} target="_blank" rel="noopener noreferrer">
							<NavLinkFavicon url={link.url} />
							{link.label}
						</a>
					</DropdownMenuItem>
				))}
				{hasGlobal && hasServer && <DropdownMenuSeparator />}
				{hasServer && serverLinks.map((link) => (
					<DropdownMenuItem key={link.url} asChild className="cursor-pointer">
						<a href={link.url} target="_blank" rel="noopener noreferrer">
							<NavLinkFavicon url={link.url} />
							{link.label}
						</a>
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function NavLinkFavicon({ url }: { url: string }) {
	const [errored, setErrored] = React.useState(false)
	const faviconUrl = React.useMemo(() => {
		try {
			const origin = new URL(url).origin
			return `${origin}/favicon.ico`
		} catch {
			return null
		}
	}, [url])

	if (!faviconUrl || errored) {
		return <Icons.ExternalLink className="mr-2 h-4 w-4 shrink-0" />
	}

	return (
		<img
			src={faviconUrl}
			alt=""
			className="mr-2 h-4 w-4 shrink-0"
			onError={() => setErrored(true)}
		/>
	)
}

const NavLink: typeof TSR.Link = (props) => {
	const baseClasses = 'text-sm sm:text-base font-medium'
	return (
		<TSR.Link
			activeProps={{ className: cn(`${baseClasses} underline`, props.className) }}
			preload="intent"
			className={cn(baseClasses, props.className)}
			{...props}
		>
			{props.children}
		</TSR.Link>
	)
}
