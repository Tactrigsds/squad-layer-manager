import * as Msgs from '@/messages/shared'

// App-level text belonging to no narrower domain, and the home for a message two domains share.

// The product name. A brand rather than a phrase, so it is the one string here that no locale rewrites; it is a
// message anyway because it is spelled out in five places and a rename should touch one.
export const productName = Msgs.def('Squad Layer Manager')

// Part of the brand voice (docs/brand.md): always the full sentence, "and other things also" included.
export const tagline = Msgs.def('A tool to manage the upcoming layers of a squad server, and other things also.')

// what was copied goes in the description, since the title is the same wherever the app copies something
export const copiedToClipboard = Msgs.def((what: string) => ({
	toast: () => [Msgs.t('Copied to clipboard'), { description: what }],
}))

// -------- the about page --------

export const about = Msgs.def('About')

export const aboutBlurb = Msgs.def(
	'Squad Layer Manager(SLM) is a tool for managing the upcoming layers of a squad server. and other things also.',
)

export const repositoryHeading = Msgs.def('Repository:')

export const reportIssuesHeading = Msgs.def('Report issues here, including the information below:')

// The block the issue reporter is asked to paste. One message rather than four labels: which lines are present
// depends on what the instance knows about itself, and the omissions only read correctly as a whole.
export const versionInfo = Msgs.def((info: { appVersion?: string; layersVersion?: string; username?: string; wsClientId?: string }) =>
	[
		info.appVersion && `App Version: ${info.appVersion}`,
		info.layersVersion && `Layer Pool Version: ${info.layersVersion}`,
		info.username && `Logged in as: ${info.username}`,
		info.wsClientId && `WebSocket Client ID: ${info.wsClientId}`,
	]
		.filter(Boolean)
		.join('\n'),
)

export const versionInfoCopied = Msgs.def('Version information has been copied')

// -------- the nav bar --------

export const navServer = Msgs.def('Server')

export const navCommands = Msgs.def('Commands')

export const navFilters = Msgs.def('Filters')

export const navSettings = Msgs.def('Settings')

export const exploreLayers = Msgs.def('Explore Layers')

// the explore-layers dialog's own title, which names what is being picked rather than the action
export const layersDialogTitle = Msgs.def('Layers')

export const userMenu = Msgs.def('User menu')

export const logOut = Msgs.def('Log Out')

export const setNickname = Msgs.def('Set Nickname')

export const linkedSteamAccounts = Msgs.def('Linked Steam Accounts')

export const permissions = Msgs.def('Permissions')

export const normalizeTeams = Msgs.def('Normalize Teams')

export const normalizeTeamsHint = Msgs.def('Show team A on the left and team B on the right, instead of team 1 and team 2')

// -------- theme --------

export const language = Msgs.def('Language')

// following the browser rather than pinning one
export const languageAuto = Msgs.def('Automatic')

export const theme = Msgs.def('Theme')

export const themeNames = { light: 'Light', dark: 'Dark', system: 'System' }

// -------- the simulation and connection banners --------

export const stopSimulating = Msgs.def('Stop Simulating')

export const simulating = Msgs.def('Simulating')

export const disconnectedFromServer = Msgs.def('Disconnected from server')

export const connectingToServer = Msgs.def('Connecting to server...')

// -------- the primary panel's tabs --------

export const queueTab = Msgs.def('Queue ({count})', (count: number) => ({ count }))

export const teamsTab = Msgs.def('Teams ({count})', (count: number) => ({ count }))

export const finishedEditing = Msgs.def('Finished editing')

// -------- the servers index --------

export const managedServers = Msgs.def('Managed Servers')

export const noServersAvailable = Msgs.def('No servers available.')

export const somethingWentWrong = Msgs.def('Something went wrong')

// -------- what a suspended subtree says while it waits --------
// The odd casing of "This page" mid-sentence is inherited from the noun phrase this was built around before the
// sentences were spelled out, and is preserved here rather than quietly corrected.

export type BoundarySubject = 'global-settings' | 'page'

const subjectNames: Record<BoundarySubject, string> = {
	'global-settings': 'global settings',
	page: 'This page',
}

export const boundaryLoading = Msgs.def(
	"{state, select, waiting {Loading {subject}…} slow {Still waiting on {subject}…} other {Reconnecting, {subject} will load once we're back…}}",
	(subject: BoundarySubject, state: 'waiting' | 'slow' | 'reconnecting') => ({ subject: subjectNames[subject], state }),
)

export const boundaryFailed = Msgs.def(
	"{timedOut, select, yes {{subject} didn't load} other {{subject} failed}}",
	(subject: BoundarySubject, timedOut: boolean) => ({ subject: subjectNames[subject], timedOut: timedOut ? 'yes' : 'no' }),
)

export const boundaryTimedOutBlurb = Msgs.def('The server never sent this data. It may be busy or in a bad state.')

export const retry = Msgs.def('Retry')

export const routeSuspended = Msgs.def('Route suspended, waiting on state…')
