import * as Msgs from '@/messages/shared'

// App-level text belonging to no narrower domain, and the home for a message two domains share.

// The product name. A brand rather than a phrase, so it is the one string here that no locale rewrites; it is a
// message anyway because it is spelled out in five places and a rename should touch one.
export const productName = Msgs.def(() => ({ text: () => 'Squad Layer Manager' }))

// what was copied goes in the description, since the title is the same wherever the app copies something
export const copiedToClipboard = Msgs.def((what: string) => ({
	toast: () => ['Copied to clipboard', { description: what }],
}))

// -------- the about dialog --------

export const about = Msgs.def(() => ({ text: () => 'About' }))

export const aboutBlurb = Msgs.def(() => ({
	text: () => 'Squad Layer Manager(SLM) is a tool for managing the upcoming layers of a squad server. and other things also.',
}))

export const repositoryHeading = Msgs.def(() => ({ text: () => 'Repository:' }))

export const reportIssuesHeading = Msgs.def(() => ({ text: () => 'Report issues here, including the information below:' }))

// The block the issue reporter is asked to paste. One message rather than four labels: which lines are present
// depends on what the instance knows about itself, and the omissions only read correctly as a whole.
export const versionInfo = Msgs.def((info: { appVersion?: string; layersVersion?: string; username?: string; wsClientId?: string }) => ({
	text: () =>
		[
			info.appVersion && `App Version: ${info.appVersion}`,
			info.layersVersion && `Layer Pool Version: ${info.layersVersion}`,
			info.username && `Logged in as: ${info.username}`,
			info.wsClientId && `WebSocket Client ID: ${info.wsClientId}`,
		]
			.filter(Boolean)
			.join('\n'),
}))

export const versionInfoCopied = Msgs.def(() => ({ text: () => 'Version information has been copied' }))

// -------- the nav bar --------

export const navServer = Msgs.def(() => ({ text: () => 'Server' }))

export const navCommands = Msgs.def(() => ({ text: () => 'Commands' }))

export const navFilters = Msgs.def(() => ({ text: () => 'Filters' }))

export const navSettings = Msgs.def(() => ({ text: () => 'Settings' }))

export const exploreLayers = Msgs.def(() => ({ text: () => 'Explore Layers' }))

// the explore-layers dialog's own title, which names what is being picked rather than the action
export const layersDialogTitle = Msgs.def(() => ({ text: () => 'Layers' }))

export const userMenu = Msgs.def(() => ({ text: () => 'User menu' }))

export const logOut = Msgs.def(() => ({ text: () => 'Log Out' }))

export const setNickname = Msgs.def(() => ({ text: () => 'Set Nickname' }))

export const linkedSteamAccounts = Msgs.def(() => ({ text: () => 'Linked Steam Accounts' }))

export const permissions = Msgs.def(() => ({ text: () => 'Permissions' }))

export const normalizeTeams = Msgs.def(() => ({ text: () => 'Normalize Teams' }))

export const normalizeTeamsHint = Msgs.def(() => ({
	text: () => 'Show team A on the left and team B on the right, instead of team 1 and team 2',
}))

// -------- theme --------

export const theme = Msgs.def(() => ({ text: () => 'Theme' }))

export const themeNames = { light: 'Light', dark: 'Dark', system: 'System' }

// -------- the simulation and connection banners --------

export const stopSimulating = Msgs.def(() => ({ text: () => 'Stop Simulating' }))

export const simulating = Msgs.def(() => ({ text: () => 'Simulating' }))

export const disconnectedFromServer = Msgs.def(() => ({ text: () => 'Disconnected from server' }))

export const connectingToServer = Msgs.def(() => ({ text: () => 'Connecting to server...' }))

// -------- the primary panel's tabs --------

export const queueTab = Msgs.def((count: number) => ({ text: () => `Queue (${count})` }))

export const teamsTab = Msgs.def((count: number) => ({ text: () => `Teams (${count})` }))

export const finishedEditing = Msgs.def(() => ({ text: () => 'Finished editing' }))

// -------- the servers index --------

export const managedServers = Msgs.def(() => ({ text: () => 'Managed Servers' }))

export const noServersAvailable = Msgs.def(() => ({ text: () => 'No servers available.' }))

export const somethingWentWrong = Msgs.def(() => ({ text: () => 'Something went wrong' }))

// -------- what a suspended subtree says while it waits --------
// There are only two things the app ever waits on, so each sentence is spelled out per subject rather than built
// around an interpolated noun. The odd casing mid-sentence is inherited from the old interpolation, which
// substituted a noun phrase written for one position into all five.

export type BoundarySubject = 'global-settings' | 'page'

const boundaryLoadingText: Record<BoundarySubject, string> = {
	'global-settings': 'Loading global settings…',
	page: 'Loading This page…',
}

const boundaryStillWaitingText: Record<BoundarySubject, string> = {
	'global-settings': 'Still waiting on global settings…',
	page: 'Still waiting on This page…',
}

const boundaryReconnectingText: Record<BoundarySubject, string> = {
	'global-settings': "Reconnecting, global settings will load once we're back…",
	page: "Reconnecting, This page will load once we're back…",
}

export const boundaryLoading = Msgs.def((subject: BoundarySubject, state: 'waiting' | 'slow' | 'reconnecting') => ({
	text: () =>
		state === 'waiting'
			? boundaryLoadingText[subject]
			: state === 'slow'
				? boundaryStillWaitingText[subject]
				: boundaryReconnectingText[subject],
}))

const boundaryTimedOutTitle: Record<BoundarySubject, string> = {
	'global-settings': "global settings didn't load",
	page: "This page didn't load",
}

const boundaryFailedTitle: Record<BoundarySubject, string> = {
	'global-settings': 'global settings failed',
	page: 'This page failed',
}

export const boundaryFailed = Msgs.def((subject: BoundarySubject, timedOut: boolean) => ({
	text: () => (timedOut ? boundaryTimedOutTitle[subject] : boundaryFailedTitle[subject]),
}))

export const boundaryTimedOutBlurb = Msgs.def(() => ({
	text: () => 'The server never sent this data. It may be busy or in a bad state.',
}))

export const retry = Msgs.def(() => ({ text: () => 'Retry' }))

export const routeSuspended = Msgs.def(() => ({ text: () => 'Route suspended, waiting on state…' }))
