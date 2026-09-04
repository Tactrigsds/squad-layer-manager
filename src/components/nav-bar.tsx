import * as TSR from '@tanstack/react-router'
import * as Icons from 'lucide-react'
import React from 'react'

import * as AR from '@/app-routes.ts'
import LinkSteamAccountDialog from '@/components/link-steam-account-dialog'
import LogoMark from '@/components/logo-mark'
import NicknameDialog from '@/components/nickname-dialog'
import SelectLayersDialog from '@/components/select-layers-dialog'
import { ServerActionMenuItems, ServerActionsDropdown } from '@/components/server-actions-dropdown'
import { dropdownMenuSlots } from '@/components/server-actions-dropdown'
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import UserPermissionsDialog from '@/components/user-permissions-dialog'
import { frameManager, useFrameLifecycle, useFrameTeardownOnUnmount } from '@/frames/frame-manager.ts'
import * as SelectLayersFrame from '@/frames/select-layers.frame.ts'
import * as SquadServerFrame from '@/frames/squad-server.frame.ts'
import { useIsDesktopSize, useIsMediumViewport, useIsSmallViewport } from '@/lib/browser.ts'
import * as Obj from '@/lib/object-utils'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as APP_Msgs from '@/messages/app.messages'
import * as SS_Msgs from '@/messages/server-state.messages'
import * as RPC from '@/orpc.client'
import * as ClientOnlySettings from '@/systems/client-only-settings.client'
import * as ConfigClient from '@/systems/config.client'
import * as FeatureFlags from '@/systems/feature-flags.client'
import * as MessagesClient from '@/systems/messages.client'
import { tr } from '@/systems/messages.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SettingsClient from '@/systems/settings.client'
import * as SiteMode from '@/systems/site-mode.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as UsersClient from '@/systems/users.client'

const EXPLORE_LAYERS_FRAME_INSTANCE_ID = 'explore-layers'

type PageLink = { key: string; label: string; to: string; params?: Record<string, string>; search?: Record<string, string> }

/**
 * The bar folds by width rather than scrolling. 1280 and up: every page link. 900 to 1279: the dashboard's tab
 * switch stays, links that stop fitting fold from the right into a More menu, Server Actions becomes an icon and
 * the server picker truncates. 640 to 899: every page link lives in a Pages menu and Explore Layers is an icon.
 * Below 640 the bar is the phone top bar: menu, the server name (or page title), Server Actions and the avatar.
 */
export default function NavBar() {
	const flags = FeatureFlags.useFeatureFlags()
	const wsStatus = RPC.useConnectStatus()
	const { simulate, setSimulate } = Zus.useStore(RbacClient.RbacStore, RbacClient.Sel.simulateControls)
	const user = UsersClient.useLoggedInUser()

	const avatarUrl = user?.avatarUrl

	const isOnServerDashboard = TSR.useMatch({ from: '/_app/servers/$serverId', shouldThrow: false })
	const isDesktop = useIsDesktopSize()
	const isMedium = useIsMediumViewport()
	const isSmall = useIsSmallViewport()
	const activeDashboardTab = Zus.useStore(SquadServerClient.DashboardTabStore, (s) => s.activeTab)
	// in single-column mode the dashboard has no room for its own tab cluster, so the switcher takes over the "Server" nav slot
	const showDashboardTabs = !!isOnServerDashboard && !isDesktop && !isSmall

	const [openState, setDropdownState] = React.useState<'primary' | 'permissions' | 'steam-link' | 'nickname' | null>(null)
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

	const { choice: localeChoice, setChoice: setLocaleChoice } = MessagesClient.useLocale()
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
	const serverNavLinks = Zus.useStore(squadServerKey, (s) => s?.settings.saved.navLinks)

	const showSettingsLink = Zus.useStore_Susp(
		UsersClient.loggedInUserQueryOptions,
		RbacClient.RbacStore,
		SettingsClient.PublicSettingsStore,
		RbacClient.Sel.settingsLinkVisible,
	)
	const [exploreLayersOpen, setExploreLayersOpen] = React.useState(false)
	const siteMode = SiteMode.useSiteMode()
	// the desktop site on a phone: offer the way back to the phone layout
	const showMobileSwitch = !isSmall && (siteMode === 'desktop' || SiteMode.isMobileDevice())

	const pageLinks: PageLink[] = [
		selectedServer
			? { key: 'server', label: tr.text(APP_Msgs.navServer()), to: '/servers/$serverId', params: { serverId: selectedServer.id } }
			: { key: 'server', label: tr.text(APP_Msgs.navServer()), to: '/servers' },
		{ key: 'commands', label: tr.text(APP_Msgs.navCommands()), to: '/commands' },
		{ key: 'filters', label: tr.text(APP_Msgs.navFilters()), to: '/filters' },
		{ key: 'history', label: tr.text(APP_Msgs.navHistory()), to: '/history', search: { type: 'events', mode: 'basic' } },
		{ key: 'tutorials', label: tr.text(APP_Msgs.navTutorials()), to: '/tutorials' },
		...(showSettingsLink ? [{ key: 'settings', label: tr.text(APP_Msgs.navSettings()), to: '/settings' }] : []),
	]
	// the tab switcher already covers "Server" in single-column mode
	const visibleLinks = pageLinks.filter((link) => !(showDashboardTabs && link.key === 'server'))
	// how many links the bar shows inline; the rest fold into More (or all of them into Pages)
	const inlineCount = isDesktop ? visibleLinks.length : isMedium ? 3 : 0
	const inlineLinks = visibleLinks.slice(0, inlineCount)
	const foldedLinks = visibleLinks.slice(inlineCount)

	const pageMenuItems = (links: PageLink[]) =>
		links.map((link) => (
			<DropdownMenuItem key={link.key} asChild className="cursor-pointer">
				<TSR.Link to={link.to} params={link.params} search={link.search}>
					{link.label}
				</TSR.Link>
			</DropdownMenuItem>
		))

	const mobileSwitchItem = showMobileSwitch && (
		<DropdownMenuItem onClick={() => SiteMode.setSiteMode('auto')}>
			<Icons.Smartphone />
			{tr.text(APP_Msgs.switchToMobileSite())}
		</DropdownMenuItem>
	)

	// the user-avatar menu items, shared between the avatar dropdown (>= sm) and the hamburger (< sm). Rendered in exactly one
	// of those two places (gated by isSmall) so the controlled dialogs below aren't mounted twice.
	const userMenuContent = user && (
		<>
			<DropdownMenuLabel className="truncate max-w-50">{user.displayName}</DropdownMenuLabel>
			{simulate && (
				<DropdownMenuItem onClick={() => setSimulate(false)} className="sm:hidden">
					<Icons.X />
					{tr.text(APP_Msgs.stopSimulating())}
				</DropdownMenuItem>
			)}
			{wsStatus === 'closed' && (
				<DropdownMenuItem disabled className="md:hidden fd-mi-dng">
					<Spinner />
					{tr.text(APP_Msgs.disconnectedFromServer())}
				</DropdownMenuItem>
			)}
			<DropdownMenuSub>
				<DropdownMenuSubTrigger chevronLeft>{tr.text(APP_Msgs.language())}</DropdownMenuSubTrigger>
				<DropdownMenuSubContent>
					<DropdownMenuRadioGroup value={localeChoice} onValueChange={setLocaleChoice}>
						<DropdownMenuRadioItem value={MessagesClient.AUTO}>
							<Icons.Languages className="mr-2" />
							{tr.text(APP_Msgs.languageAuto())}
						</DropdownMenuRadioItem>
						{MessagesClient.availableLocales().map((locale) => (
							<DropdownMenuRadioItem key={locale} value={locale}>
								{MessagesClient.endonym(locale)}
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				</DropdownMenuSubContent>
			</DropdownMenuSub>
			<NormalizeTeamsToggle />
			<DropdownMenuSeparator />
			<NicknameDialog onOpenChange={onNicknameOpenChange} open={openState === 'nickname'}>
				<DropdownMenuItem onClick={() => setDropdownState('nickname')}>
					<Icons.User />
					{tr.text(APP_Msgs.setNickname())}
				</DropdownMenuItem>
			</NicknameDialog>
			<LinkSteamAccountDialog onOpenChange={onSteamLinkOpenChange} open={openState === 'steam-link'}>
				<DropdownMenuItem onClick={() => setDropdownState('steam-link')}>
					<Icons.Link />
					{tr.text(APP_Msgs.linkedSteamAccounts())}
				</DropdownMenuItem>
			</LinkSteamAccountDialog>
			<UserPermissionsDialog onOpenChange={onPermissionsOpenChange} open={openState === 'permissions'}>
				<DropdownMenuItem onClick={() => setDropdownState('permissions')}>
					<Icons.Shield />
					{tr.text(APP_Msgs.permissions())}
				</DropdownMenuItem>
			</UserPermissionsDialog>
			<DropdownMenuItem asChild>
				<TSR.Link to="/about">
					<Icons.Info />
					{tr.text(APP_Msgs.about())}
				</TSR.Link>
			</DropdownMenuItem>
			{mobileSwitchItem && (
				<>
					<DropdownMenuSeparator />
					{mobileSwitchItem}
				</>
			)}
			<DropdownMenuSeparator />
			<form action={AR.route('/logout')} method="POST">
				<DropdownMenuItem asChild>
					<button className="w-full" type="submit">
						<Icons.LogOut />
						{tr.text(APP_Msgs.logOut())}
					</button>
				</DropdownMenuItem>
			</form>
		</>
	)

	const avatar = user && (
		<Avatar style={{ backgroundColor: user.displayHexColor ?? undefined }} className="select-none size-6 shrink-0 border border-line">
			<AvatarImage src={avatarUrl} crossOrigin="anonymous" />
			<AvatarFallback className="text-2xs">{user.displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
		</Avatar>
	)

	const serverPicker =
		isOnServerDashboard &&
		selectedServer &&
		settings &&
		(settings.servers.length <= 1 ? (
			<span data-tour="server-name" className="fd-cond font-bold text-sm truncate">
				{selectedServer.displayName}
			</span>
		) : (
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						data-tour="server-name"
						size="sm"
						className={cn('fd-sel font-semibold', isDesktop ? 'w-[190px]' : isMedium ? 'w-[150px]' : 'w-[120px]')}
					>
						<span className="truncate">{selectedServer.displayName}</span>
						<Icons.ChevronDown />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="min-w-[--radix-dropdown-menu-trigger-width] ">
					<ServerMenuItems servers={settings.servers} selectedServerId={selectedServer.id} />
				</DropdownMenuContent>
			</DropdownMenu>
		))

	const statusCluster = (
		<>
			{simulate && !isSmall && (
				<div className="flex items-center gap-1 shrink-0">
					<span className="text-sm font-medium">{tr.text(APP_Msgs.simulating())}</span>
					<Button size="icon-sm" variant="ghost" onClick={() => setSimulate(false)}>
						<Icons.X />
					</Button>
				</div>
			)}
			{wsStatus === 'closed' && (
				<span className="fd-badge fd-badge-dng hidden md:inline-flex">
					<Spinner className="size-3" />
					{tr.text(APP_Msgs.disconnectedFromServer())}
				</span>
			)}
			{(wsStatus === 'reconnecting' || wsStatus === 'pending') && (
				<div title={tr.text(APP_Msgs.connectingToServer())}>
					<Spinner />
				</div>
			)}
			{flags.displayWsClientId && config && (
				<span className="text-xs cursor-pointer" onClick={() => navigator.clipboard.writeText(config.wsClientId)}>
					{config.wsClientId}
				</span>
			)}
		</>
	)

	if (isSmall) {
		return (
			<nav className="fd-nav h-10 gap-2 px-2">
				<PhoneMenu
					open={openState !== null}
					onOpenChange={onPrimaryDropdownOpenChange}
					pageItems={pageMenuItems(pageLinks)}
					onExploreLayers={() => setExploreLayersOpen(true)}
					serverName={selectedServer?.displayName}
					squadServerKey={isOnServerDashboard ? squadServerKey : undefined}
					servers={settings?.servers ?? []}
					selectedServerId={selectedServer?.id}
					globalLinks={settings?.navLinks}
					serverLinks={serverNavLinks}
				>
					{userMenuContent}
				</PhoneMenu>
				<span className="fd-cond font-bold text-base truncate min-w-0 flex-1">
					{isOnServerDashboard && selectedServer ? selectedServer.displayName : <CurrentPageTitle links={pageLinks} />}
				</span>
				{statusCluster}
				{isOnServerDashboard && squadServerKey && <ServerActionsDropdown stores={{ squadServer: squadServerKey }} iconOnly />}
				<ExploreLayersDialog open={exploreLayersOpen} onOpenChange={setExploreLayersOpen} />
				{avatar}
			</nav>
		)
	}

	return (
		<nav className="fd-nav h-10 gap-3 px-2.5" style={settings?.topBarColor ? { borderBottomColor: settings.topBarColor } : undefined}>
			<TSR.Link to="/about" aria-label={tr.text(APP_Msgs.about())} className="shrink-0">
				<LogoMark accent={settings?.topBarColor ?? null} className="size-6" />
			</TSR.Link>
			{/* on the dashboard's single-column layout the tab switcher takes over the "Server" nav slot at every width */}
			{showDashboardTabs && (
				<TabsList
					variant="seg"
					options={[
						{ value: 'layers', label: 'Layers & Teams' },
						{ value: 'secondary', label: 'Server Activity' },
					]}
					active={activeDashboardTab}
					setActive={SquadServerClient.DashboardTabActions.setActiveTab}
				/>
			)}
			{inlineLinks.map((link) => (
				<NavLink key={link.key} to={link.to} params={link.params} search={link.search}>
					{link.label}
				</NavLink>
			))}
			{foldedLinks.length > 0 && (
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="ghost" size="sm">
							{inlineLinks.length > 0 ? tr.text(APP_Msgs.navMore()) : tr.text(APP_Msgs.navPages())}
							<Icons.ChevronDown className="size-2.5!" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start">
						{pageMenuItems(foldedLinks)}
						{mobileSwitchItem && inlineLinks.length === 0 && (
							<>
								<DropdownMenuSeparator />
								{mobileSwitchItem}
							</>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			)}
			{isMedium ? (
				<Button size="sm" onClick={() => setExploreLayersOpen(true)}>
					{tr.text(APP_Msgs.exploreLayers())}
				</Button>
			) : (
				<Button size="icon-sm" title={tr.text(APP_Msgs.exploreLayers())} onClick={() => setExploreLayersOpen(true)}>
					<Icons.Search />
				</Button>
			)}
			<ExploreLayersDialog open={exploreLayersOpen} onOpenChange={setExploreLayersOpen} />
			<span className="flex-1 min-w-3" />
			{statusCluster}
			{isOnServerDashboard && squadServerKey && <ServerActionsDropdown stores={{ squadServer: squadServerKey }} iconOnly={!isDesktop} />}
			{isOnServerDashboard && squadServerKey && <JoinServerButton serverId={squadServerKey.serverId} />}
			{settings && <NavLinksDropdown globalLinks={settings.navLinks} serverLinks={serverNavLinks} />}
			{serverPicker}
			{user && (
				<DropdownMenu modal={false} open={openState !== null} onOpenChange={onPrimaryDropdownOpenChange}>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							aria-label={tr.text(APP_Msgs.userMenu())}
							className="rounded-full hover:cursor-pointer focus-visible:outline-2 focus-visible:outline-pri-hi"
						>
							{avatar}
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">{userMenuContent}</DropdownMenuContent>
				</DropdownMenu>
			)}
		</nav>
	)
}

function CurrentPageTitle(props: { links: PageLink[] }) {
	const pathname = TSR.useRouterState({ select: (s) => s.location.pathname })
	const link = props.links.find((l) => pathname.startsWith(l.to.replace('/$serverId', '')))
	return link?.label ?? tr.text(APP_Msgs.productName())
}

function ServerMenuItems(props: {
	servers: { id: string; displayName: string; enabled: boolean; broken?: boolean }[]
	selectedServerId: string
}) {
	return (
		<>
			{props.servers
				.filter((server) => server.id !== props.selectedServerId)
				.map((server) => (
					<DropdownMenuItem className="cursor-pointer" asChild key={server.id}>
						<TSR.Link disabled={!server.enabled || server.broken} to="/servers/$serverId" params={{ serverId: server.id }}>
							{server.displayName} <Icons.Dot className={cn(server.enabled ? 'text-ok' : 'text-danger')} />
						</TSR.Link>
					</DropdownMenuItem>
				))}
		</>
	)
}

// A button rather than a link: the url is fetched on the click (the lookups are rate-limited per server), so
// there is nothing to put in an href beforehand. Shown whenever an integration is configured, since finding out
// that a server cannot be resolved costs the same request the click would spend.
function JoinServerButton(props: { serverId: string; asMenuItem?: boolean }) {
	const joinLinkEnabled = Zus.useStore(ConfigClient.Store, ConfigClient.Sel.joinLinkEnabled)
	const isSandbox = Zus.useStore(
		SettingsClient.PublicSettingsStore,
		(s) => !!s?.servers.find((server) => server.id === props.serverId)?.sandbox,
	)
	const joinServer = SquadServerClient.useJoinServer()
	if (!joinLinkEnabled || isSandbox) return null

	const label = tr.text(SS_Msgs.joinServer())
	if (props.asMenuItem) {
		return (
			<DropdownMenuItem disabled={joinServer.isPending} onClick={() => joinServer.mutate(props.serverId)}>
				<Icons.Gamepad2 />
				{label}
			</DropdownMenuItem>
		)
	}
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					variant="ghost"
					size="icon-sm"
					className="shrink-0"
					aria-label={label}
					disabled={joinServer.isPending}
					onClick={() => joinServer.mutate(props.serverId)}
				>
					{joinServer.isPending ? <Spinner /> : <Icons.Gamepad2 />}
				</Button>
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
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
			className="justify-between gap-4"
			title={tr.text(APP_Msgs.normalizeTeamsHint())}
			onSelect={(e) => {
				e.preventDefault()
				ClientOnlySettings.Actions.setDisplayTeamsNormalized(!displayTeamsNormalized)
			}}
		>
			<span className="flex items-center gap-2">
				<Icons.ArrowLeftRight />
				{tr.text(APP_Msgs.normalizeTeams())}
			</span>
			<Switch checked={displayTeamsNormalized} tabIndex={-1} className="pointer-events-none" />
		</DropdownMenuItem>
	)
}

// the explore frame is scoped to the selected server, since its pool filters and repeat-rule constraints come from that
// server's settings. Switching servers therefore builds a fresh instance and drops the previous one, rather than leaving
// the dialog constrained by the server the page happened to load with
function ExploreLayersDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const input = SelectLayersFrame.createInput({ sharedInstanceId: EXPLORE_LAYERS_FRAME_INSTANCE_ID, rememberCollection: true })
	const frameKey = useFrameLifecycle(SelectLayersFrame.frame, { input, equalityFn: Obj.deepEqual })
	useFrameTeardownOnUnmount(frameKey)

	return (
		<SelectLayersDialog
			stores={{ selectLayers: frameKey }}
			open={props.open}
			onOpenChange={props.onOpenChange}
			title={tr.text(APP_Msgs.layersDialogTitle())}
			pinMode="layers"
		/>
	)
}

// The phone top bar's one menu: pages, Explore Layers, the server's actions, links and switch, the account
// items, and the way to the desktop site. Controlled by the shared openState so the appended user-menu dialogs
// keep it open.
function PhoneMenu(props: {
	open: boolean
	onOpenChange: (open: boolean) => void
	pageItems: React.ReactNode
	onExploreLayers: () => void
	serverName?: string
	squadServerKey?: SquadServerFrame.Key
	servers: { id: string; displayName: string; enabled: boolean; broken?: boolean }[]
	selectedServerId?: string
	globalLinks?: { label: string; url: string }[]
	serverLinks?: { label: string; url: string }[]
	children?: React.ReactNode
}) {
	const hasLinks = (props.globalLinks?.length ?? 0) + (props.serverLinks?.length ?? 0) > 0
	return (
		<DropdownMenu modal={false} open={props.open} onOpenChange={props.onOpenChange}>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="icon-sm" className="shrink-0">
					<Icons.Menu />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-[250px] [&_.fd-mi]:min-h-8">
				<DropdownMenuLabel>{tr.text(APP_Msgs.navPages())}</DropdownMenuLabel>
				{props.pageItems}
				<DropdownMenuSeparator />
				<DropdownMenuItem className="cursor-pointer" onClick={props.onExploreLayers}>
					{tr.text(APP_Msgs.exploreLayers())}
				</DropdownMenuItem>
				{props.serverName && props.squadServerKey && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuLabel className="truncate">{props.serverName}</DropdownMenuLabel>
						<DropdownMenuSub>
							<DropdownMenuSubTrigger>{tr.text(SS_Msgs.serverActions())}</DropdownMenuSubTrigger>
							<DropdownMenuSubContent>
								<ServerActionMenuItems stores={{ squadServer: props.squadServerKey }} slots={dropdownMenuSlots} />
							</DropdownMenuSubContent>
						</DropdownMenuSub>
						<JoinServerButton serverId={props.squadServerKey.serverId} asMenuItem />
						{hasLinks && (
							<DropdownMenuSub>
								<DropdownMenuSubTrigger>{tr.text(APP_Msgs.navLinks())}</DropdownMenuSubTrigger>
								<DropdownMenuSubContent>
									<NavLinkItems globalLinks={props.globalLinks} serverLinks={props.serverLinks} />
								</DropdownMenuSubContent>
							</DropdownMenuSub>
						)}
						{props.servers.length > 1 && props.selectedServerId && (
							<DropdownMenuSub>
								<DropdownMenuSubTrigger>{tr.text(APP_Msgs.switchServer())}</DropdownMenuSubTrigger>
								<DropdownMenuSubContent>
									<ServerMenuItems servers={props.servers} selectedServerId={props.selectedServerId} />
								</DropdownMenuSubContent>
							</DropdownMenuSub>
						)}
					</>
				)}
				{props.children && (
					<>
						<DropdownMenuSeparator />
						{props.children}
					</>
				)}
				<DropdownMenuSeparator />
				<DropdownMenuItem onClick={() => SiteMode.setSiteMode('desktop')}>
					<Icons.Monitor />
					{tr.text(APP_Msgs.switchToDesktopSite())}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function NavLinkItems({
	globalLinks,
	serverLinks,
}: {
	globalLinks?: { label: string; url: string }[]
	serverLinks?: { label: string; url: string }[]
}) {
	const hasGlobal = globalLinks && globalLinks.length > 0
	const hasServer = serverLinks && serverLinks.length > 0
	return (
		<>
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
		</>
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
				<Button variant="ghost" size="icon-sm" className="shrink-0" title={tr.text(APP_Msgs.navLinks())}>
					<Icons.Link2 />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<NavLinkItems globalLinks={globalLinks} serverLinks={serverLinks} />
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
		return <Icons.ExternalLink className="shrink-0" />
	}

	return <img src={faviconUrl} alt="" className="size-3.5 shrink-0" onError={() => setErrored(true)} />
}

const NavLink: typeof TSR.Link = (props) => {
	return (
		<TSR.Link
			activeProps={{ className: cn('fd-nav-link', 'fd-nav-link-on', props.className) }}
			preload="intent"
			className={cn('fd-nav-link', props.className)}
			{...props}
		>
			{props.children}
		</TSR.Link>
	)
}
