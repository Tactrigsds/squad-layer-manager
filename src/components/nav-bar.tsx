import * as TSR from '@tanstack/react-router'
import * as Icons from 'lucide-react'
import React from 'react'

import * as AR from '@/app-routes.ts'
import AboutDialog from '@/components/about-dialog'
import LinkSteamAccountDialog from '@/components/link-steam-account-dialog'
import LogoMark from '@/components/logo-mark'
import NicknameDialog from '@/components/nickname-dialog'
import SelectLayersDialog from '@/components/select-layers-dialog'
import { ServerActionsDropdown } from '@/components/server-actions-dropdown'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import TabsList from '@/components/ui/tabs-list'
import UserPermissionsDialog from '@/components/user-permissions-dialog'
import { frameManager, useFrameLifecycle, useFrameTeardownOnUnmount } from '@/frames/frame-manager.ts'
import * as SelectLayersFrame from '@/frames/select-layers.frame.ts'
import * as SquadServerFrame from '@/frames/squad-server.frame.ts'
import { useIsDesktopSize, useIsSmallViewport } from '@/lib/browser.ts'
import * as Obj from '@/lib/object-utils'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as APP_Msgs from '@/messages/app.messages'
import * as RPC from '@/orpc.client'
import * as ClientOnlySettings from '@/systems/client-only-settings.client'
import * as ConfigClient from '@/systems/config.client'
import * as FeatureFlags from '@/systems/feature-flags.client'
import * as LocaleClient from '@/systems/locale.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SettingsClient from '@/systems/settings.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as ThemeClient from '@/systems/theme.client'
import * as UsersClient from '@/systems/users.client'

const EXPLORE_LAYERS_FRAME_INSTANCE_ID = 'explore-layers'

export default function NavBar() {
	const flags = FeatureFlags.useFeatureFlags()
	const wsStatus = RPC.useConnectStatus()
	const { simulate, setSimulate } = Zus.useStore(RbacClient.RbacStore, RbacClient.Sel.simulateControls)
	const user = UsersClient.useLoggedInUser()

	const avatarUrl = user?.avatarUrl

	// Check if we're on the server dashboard route
	const isOnServerDashboard = TSR.useMatch({ from: '/_app/servers/$serverId', shouldThrow: false })
	const isDesktop = useIsDesktopSize()
	// below sm the nav links + user-avatar options all collapse into a single hamburger menu
	const isSmall = useIsSmallViewport()
	const activeDashboardTab = Zus.useStore(SquadServerClient.DashboardTabStore, (s) => s.activeTab)
	// in single-column mode the dashboard has no room for its own tab cluster, so the switcher takes over the "Server" nav slot
	const showDashboardTabs = !!isOnServerDashboard && !isDesktop

	const [openState, setDropdownState] = React.useState<'primary' | 'permissions' | 'steam-link' | 'nickname' | 'about' | null>(null)
	const onPrimaryDropdownOpenChange = (newState: boolean) => {
		if (openState !== 'primary' && openState !== null) return
		setDropdownState(newState ? 'primary' : null)
	}
	const onPermissionsOpenChange = (newState: boolean) => {
		setDropdownState(newState ? 'permissions' : null)
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
	const { choice: localeChoice, setChoice: setLocaleChoice } = LocaleClient.useLocale()
	const config = Zus.useStore(ConfigClient.Store)
	const settings = Zus.useStore(SettingsClient.PublicSettingsStore)
	const selectedServerId = Zus.useStore(SquadServerClient.SelectedServerStore, (s) => s.selectedServerId)
	const selectedServer = settings?.servers.find((server) => server.id === selectedServerId)
	// NavBar isn't a descendant of the servers/$serverId route, so it can't receive the frame via props --
	// ensureSetup just dedupes onto the instance the route already created. Only set up a frame for a usable server;
	// building one for a disabled/missing server would spam subscription errors against a managed server that doesn't exist.
	const squadServerKey = React.useMemo(
		() =>
			SettingsClient.isServerUsable(selectedServer)
				? frameManager.ensureSetup(SquadServerFrame.frame, SquadServerFrame.createInput(selectedServer.id))
				: undefined,
		[selectedServer],
	)

	const showSettingsLink = Zus.useStore_Susp(
		UsersClient.loggedInUserQueryOptions,
		RbacClient.RbacStore,
		SettingsClient.PublicSettingsStore,
		RbacClient.Sel.settingsLinkVisible,
	)
	const [exploreLayersOpen, setExploreLayersOpen] = React.useState(false)

	// the user-avatar menu items, shared between the avatar dropdown (>= sm) and the hamburger (< sm). Rendered in exactly one
	// of those two places (gated by isSmall) so the controlled dialogs below aren't mounted twice.
	const userMenuContent = user && (
		<>
			<DropdownMenuLabel className="truncate max-w-50">{user.displayName}</DropdownMenuLabel>
			{simulate && (
				<DropdownMenuItem onClick={() => setSimulate(false)} className="sm:hidden text-sm">
					<Icons.X className="mr-2 h-4 w-4" />
					{APP_Msgs.stopSimulating().text()}
				</DropdownMenuItem>
			)}
			{wsStatus === 'closed' && (
				<DropdownMenuItem disabled className="md:hidden text-destructive text-sm">
					<span className="flex space-x-2 items-center">
						<Spinner className="h-4 w-4" />
						<AlertTitle className="text-xs font-medium">{APP_Msgs.disconnectedFromServer().text()}</AlertTitle>
					</span>
				</DropdownMenuItem>
			)}
			<DropdownMenuSub>
				<DropdownMenuSubTrigger className="text-sm" chevronLeft>
					{APP_Msgs.theme().text()}
				</DropdownMenuSubTrigger>
				<DropdownMenuSubContent>
					<DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as 'dark' | 'light' | 'system')}>
						<DropdownMenuRadioItem value="light" className="text-sm">
							<Icons.Sun className="mr-2 h-4 w-4" />
							{APP_Msgs.themeNames.light}
						</DropdownMenuRadioItem>
						<DropdownMenuRadioItem value="dark" className="text-sm">
							<Icons.Moon className="mr-2 h-4 w-4" />
							{APP_Msgs.themeNames.dark}
						</DropdownMenuRadioItem>
						<DropdownMenuRadioItem value="system" className="text-sm">
							<Icons.Monitor className="mr-2 h-4 w-4" />
							{APP_Msgs.themeNames.system}
						</DropdownMenuRadioItem>
					</DropdownMenuRadioGroup>
				</DropdownMenuSubContent>
			</DropdownMenuSub>
			<DropdownMenuSub>
				<DropdownMenuSubTrigger className="text-sm" chevronLeft>
					{APP_Msgs.language().text()}
				</DropdownMenuSubTrigger>
				<DropdownMenuSubContent>
					<DropdownMenuRadioGroup value={localeChoice} onValueChange={setLocaleChoice}>
						<DropdownMenuRadioItem value={LocaleClient.AUTO} className="text-sm">
							<Icons.Languages className="mr-2 h-4 w-4" />
							{APP_Msgs.languageAuto().text()}
						</DropdownMenuRadioItem>
						{LocaleClient.availableLocales().map((locale) => (
							<DropdownMenuRadioItem key={locale} value={locale} className="text-sm">
								{LocaleClient.endonym(locale)}
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				</DropdownMenuSubContent>
			</DropdownMenuSub>
			<NormalizeTeamsToggle />
			<DropdownMenuSeparator />
			<NicknameDialog onOpenChange={onNicknameOpenChange} open={openState === 'nickname'}>
				<DropdownMenuItem onClick={() => setDropdownState('nickname')} className="text-sm">
					<Icons.User className="mr-2 h-4 w-4" />
					{APP_Msgs.setNickname().text()}
				</DropdownMenuItem>
			</NicknameDialog>
			<LinkSteamAccountDialog onOpenChange={onSteamLinkOpenChange} open={openState === 'steam-link'}>
				<DropdownMenuItem onClick={() => setDropdownState('steam-link')} className="text-sm">
					<Icons.Link className="mr-2 h-4 w-4" />
					{APP_Msgs.linkedSteamAccounts().text()}
				</DropdownMenuItem>
			</LinkSteamAccountDialog>
			<UserPermissionsDialog onOpenChange={onPermissionsOpenChange} open={openState === 'permissions'}>
				<DropdownMenuItem onClick={() => setDropdownState('permissions')} className="text-sm">
					<Icons.Shield className="mr-2 h-4 w-4" />
					{APP_Msgs.permissions().text()}
				</DropdownMenuItem>
			</UserPermissionsDialog>
			<AboutDialog onOpenChange={onAboutOpenChange} open={openState === 'about'}>
				<DropdownMenuItem onClick={() => setDropdownState('about')} className="text-sm">
					<Icons.Info className="mr-2 h-4 w-4" />
					{APP_Msgs.about().text()}
				</DropdownMenuItem>
			</AboutDialog>
			<DropdownMenuSeparator />
			<form action={AR.route('/logout')} method="POST">
				<DropdownMenuItem asChild>
					<button className="w-full text-sm" type="submit">
						<Icons.LogOut className="mr-2 h-4 w-4" />
						{APP_Msgs.logOut().text()}
					</button>
				</DropdownMenuItem>
			</form>
		</>
	)

	return (
		<nav
			className="flex h-16 shrink-0 items-center justify-between border-b px-2 sm:px-4"
			style={settings?.topBarColor ? { borderBottom: `2px solid ${settings.topBarColor}` } : undefined}
		>
			<div className="flex items-center space-x-3 sm:space-x-6">
				<LogoMark accent={settings?.topBarColor ?? null} className="h-9 w-9" />
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
						{!showDashboardTabs &&
							(selectedServer ? (
								<NavLink params={{ serverId: selectedServer.id }} to="/servers/$serverId">
									{APP_Msgs.navServer().text()}
								</NavLink>
							) : (
								<NavLink to="/servers">{APP_Msgs.navServer().text()}</NavLink>
							))}
						<NavLink to="/commands">{APP_Msgs.navCommands().text()}</NavLink>
						<NavLink to="/filters">{APP_Msgs.navFilters().text()}</NavLink>
						{showSettingsLink && <NavLink to="/settings">{APP_Msgs.navSettings().text()}</NavLink>}
						<Button variant="secondary" size="sm" onClick={() => setExploreLayersOpen(true)}>
							{APP_Msgs.exploreLayers().text()}
						</Button>
					</div>
				)}
			</div>
			<ExploreLayersDialog open={exploreLayersOpen} onOpenChange={setExploreLayersOpen} />
			<div className="flex h-max min-h-0 flex-row items-center space-x-1 sm:space-x-3 overflow-hidden">
				{simulate && (
					<div className="hidden sm:flex items-center space-x-1 shrink-0">
						<span className="text-sm font-medium">{APP_Msgs.simulating().text()}</span>{' '}
						<Button size="icon" variant="ghost" onClick={() => setSimulate(false)}>
							<Icons.X className="h-4 w-4" />
						</Button>
					</div>
				)}

				{wsStatus === 'closed' && (
					<Alert variant="destructive" className="hidden md:flex space-x-2 py-1 px-2">
						<span className="flex space-x-2 items-center">
							<Spinner className="h-4 w-4" />
							<AlertTitle className="text-xs font-medium">{APP_Msgs.disconnectedFromServer().text()}</AlertTitle>
						</span>
					</Alert>
				)}
				{(wsStatus === 'reconnecting' || wsStatus === 'pending') && (
					<div title={APP_Msgs.connectingToServer().text()}>
						<Spinner />
					</div>
				)}
				{flags.displayWsClientId && config && (
					<span className="text-xs cursor-pointer" onClick={() => navigator.clipboard.writeText(config.wsClientId)}>
						{config.wsClientId}
					</span>
				)}
				{isOnServerDashboard && squadServerKey && <ServerActionsDropdown stores={{ squadServer: squadServerKey }} />}
				{settings && <NavLinksDropdown globalLinks={settings.navLinks} />}
				{isOnServerDashboard &&
					selectedServer &&
					settings &&
					(() => {
						const servers = settings.servers
						return servers.length <= 1 ? (
							<div className="font-medium text-sm">{selectedServer.displayName}</div>
						) : (
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button variant="outline">
										{selectedServer.displayName}
										<Icons.ChevronDown className="ml-2 h-4 w-4" />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="start" className="min-w-[--radix-dropdown-menu-trigger-width] ">
									{servers
										.filter((server) => server.id !== selectedServer.id)
										.map((server) => (
											<DropdownMenuItem className="cursor-pointer" asChild key={server.id}>
												<TSR.Link
													disabled={!server.enabled || server.broken}
													to="/servers/$serverId"
													params={{ serverId: server.id }}
												>
													{server.displayName} <Icons.Dot className={cn(server.enabled ? 'text-green-500' : 'text-red-500')} />
												</TSR.Link>
											</DropdownMenuItem>
										))}
								</DropdownMenuContent>
							</DropdownMenu>
						)
					})()}
				{user &&
					// below sm the avatar's options live in the hamburger, so the avatar is just a (non-interactive) identity marker
					(isSmall ? (
						<Avatar style={{ backgroundColor: user.displayHexColor ?? undefined }} className="select-none h-8 w-8 shrink-0">
							<AvatarImage src={avatarUrl} crossOrigin="anonymous" />
							<AvatarFallback className="text-xs">{user.displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
						</Avatar>
					) : (
						<DropdownMenu modal={false} open={openState !== null} onOpenChange={onPrimaryDropdownOpenChange}>
							<DropdownMenuTrigger asChild>
								<Avatar
									aria-label={APP_Msgs.userMenu().text()}
									style={{ backgroundColor: user.displayHexColor ?? undefined }}
									className="hover:cursor-pointer select-none h-8 w-8 sm:h-10 sm:w-10 shrink-0"
								>
									<AvatarImage src={avatarUrl} crossOrigin="anonymous" />
									<AvatarFallback className="text-xs sm:text-sm">{user.displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
								</Avatar>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">{userMenuContent}</DropdownMenuContent>
						</DropdownMenu>
					))}
			</div>
		</nav>
	)
}

// The switch is presentational: the menu item owns the toggle so it also responds to keyboard selection, and
// preventing the default select keeps the menu open across flips.
function NormalizeTeamsToggle() {
	const displayTeamsNormalized = Zus.useStore(ClientOnlySettings.Store, (s) => s.displayTeamsNormalized)
	return (
		<DropdownMenuItem
			role="menuitemcheckbox"
			aria-checked={displayTeamsNormalized}
			className="text-sm justify-between gap-4"
			title={APP_Msgs.normalizeTeamsHint().text()}
			onSelect={(e) => {
				e.preventDefault()
				ClientOnlySettings.Actions.setDisplayTeamsNormalized(!displayTeamsNormalized)
			}}
		>
			<span className="flex items-center">
				<Icons.ArrowLeftRight className="mr-2 h-4 w-4" />
				{APP_Msgs.normalizeTeams().text()}
			</span>
			<Switch checked={displayTeamsNormalized} tabIndex={-1} className="pointer-events-none" />
		</DropdownMenuItem>
	)
}

// the explore frame is scoped to the selected server, since its pool filters and repeat-rule constraints come from that
// server's settings. Switching servers therefore builds a fresh instance and drops the previous one, rather than leaving
// the dialog constrained by the server the page happened to load with
function ExploreLayersDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const input = SelectLayersFrame.createInput({ sharedInstanceId: EXPLORE_LAYERS_FRAME_INSTANCE_ID })
	const frameKey = useFrameLifecycle(SelectLayersFrame.frame, { input, equalityFn: Obj.deepEqual })
	useFrameTeardownOnUnmount(frameKey)

	return (
		<SelectLayersDialog
			stores={{ selectLayers: frameKey }}
			open={props.open}
			onOpenChange={props.onOpenChange}
			title={APP_Msgs.layersDialogTitle().text()}
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
						{props.selectedServerId ? (
							<TSR.Link to="/servers/$serverId" params={{ serverId: props.selectedServerId }}>
								{APP_Msgs.navServer().text()}
							</TSR.Link>
						) : (
							<TSR.Link to="/servers">{APP_Msgs.navServer().text()}</TSR.Link>
						)}
					</DropdownMenuItem>
				)}
				<DropdownMenuItem asChild className="cursor-pointer">
					<TSR.Link to="/commands">{APP_Msgs.navCommands().text()}</TSR.Link>
				</DropdownMenuItem>
				<DropdownMenuItem asChild className="cursor-pointer">
					<TSR.Link to="/filters">{APP_Msgs.navFilters().text()}</TSR.Link>
				</DropdownMenuItem>
				{props.showSettingsLink && (
					<DropdownMenuItem asChild className="cursor-pointer">
						<TSR.Link to="/settings">{APP_Msgs.navSettings().text()}</TSR.Link>
					</DropdownMenuItem>
				)}
				<DropdownMenuItem className="cursor-pointer" onClick={props.onExploreLayers}>
					{APP_Msgs.exploreLayers().text()}
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

function NavLinksDropdown({
	globalLinks,
	serverLinks,
}: {
	globalLinks?: { label: string; url: string }[]
	serverLinks?: { label: string; url: string }[]
}) {
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
				{hasGlobal &&
					globalLinks.map((link) => (
						<DropdownMenuItem key={link.url} asChild className="cursor-pointer">
							<a href={link.url} target="_blank" rel="noopener noreferrer">
								<NavLinkFavicon url={link.url} />
								{link.label}
							</a>
						</DropdownMenuItem>
					))}
				{hasGlobal && hasServer && <DropdownMenuSeparator />}
				{hasServer &&
					serverLinks.map((link) => (
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

	return <img src={faviconUrl} alt="" className="mr-2 h-4 w-4 shrink-0" onError={() => setErrored(true)} />
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
