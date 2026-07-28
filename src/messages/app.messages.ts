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

// -------- the debug info page --------

export const about = Msgs.def('About')

export const debugAndHelpInfo = Msgs.def('Debug & Help Info')

export const repositoryHeading = Msgs.def('Repository:')

export const reportIssuesHeading = Msgs.def('Report issues here, including the information below:')

export const helpHeading = Msgs.def('Ask for help here:')

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

// -------- acknowledgements --------

export const acknowledgementsHeading = Msgs.def('Acknowledgements')

// Prose rather than a label per person, so who is credited and what for reads as sentences a translator can rearrange.
// Each stays one string literal however long it runs: the extractor keys a message by a literal, and a concatenation
// leaves it out of the catalogue. The names below are the whole content of the section; edit them here.
export const acknowledgementsIntro = Msgs.def(() => ({
	react: () =>
		Msgs.node(
			'SLM is built and maintained by <strong>grey275</strong>. However, it exists because of the <strong>Tactrig</strong> community. These are the people who made significant contributions to it.',
			Msgs.tags,
		),
}))

export const acknowledgementsZero = Msgs.def(() => ({
	react: () =>
		Msgs.node(
			"<strong>Zero</strong>, for kicking the project off, and for his incredible work building out the layer scoring system that is integral to SLM. Our discussions also shaped much of the early featureset, which became some of SLM's defining characteristics. Without his effort this project wouldn't have been feasible.",
			Msgs.tags,
		),
}))

export const acknowledgementsRandyNewman = Msgs.def(() => ({
	react: () =>
		Msgs.node(
			"<strong>Randy Newman</strong>, instrumental in getting SLM into TT's admin workflow by making hardware available for deployment and writing approachable documentation. He graciously put up with my constant feature additions, which made his job harder at every turn.",
			Msgs.tags,
		),
}))

export const acknowledgementsContributorsIntro = Msgs.def(
	"Thank you to everyone below, who helped me not just with bugs but with feature requests and suggestions too. You had a real hand in shaping SLM's featureset.",
)

export const acknowledgementsUsersIntro = Msgs.def(
	"And thanks to everyone who actually chose to learn and use SLM even as it proved to be unstable. All of you have more than 100 (!!!) layer sets, so many that at the time of writing I'm not even in the top 5 by layer set count anymore.",
)

// not messages: a name is the same in every locale
export const acknowledgedContributors = [
	'FancyFos',
	'nvvy',
	'Logano Stefano',
	'MyEggo',
	'Gaites',
	'Hutchinman',
	'India Golf 99',
	'ItsJessedMe',
	'AbradantMatthew',
	'Scriptum',
	'ChaosMuppet',
	'crustacean_ultra',
	'Siiz',
	'John Wikipedia of Not Service Related',
	'AtLeastImCooler',
]

export const acknowledgedUsers = ['Arrow2', 'BitingWit', 'dexii', 'LonelyNinja', 'sniffles', 'TomClaz', 'BosD']

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
