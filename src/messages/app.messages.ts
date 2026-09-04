import { def, join, raw, rt, t, type TString } from '@/models/messages.models'

// App-level text belonging to no narrower domain, and the home for a message two domains share.

// The product name. A brand rather than a phrase, so it is the one string here that no locale rewrites; it is a
// message anyway because it is spelled out in five places and a rename should touch one.
export const productName = def('Squad Layer Manager')

// Part of the brand voice (docs/brand.md): always the full sentence, "and other things also" included.
export const tagline = def('A tool to manage the upcoming layers of a squad server, and other things also.')

// what was copied goes in the description, since the title is the same wherever the app copies something
export const copiedToClipboard = def((what: string) => ({
	toast: [t('Copied to clipboard'), { description: raw(what) }],
}))

// -------- the debug info page --------

export const about = def('About')

export const debugAndHelpInfo = def('Debug & Help Info')

export const repositoryHeading = def('Repository:')

export const reportIssuesHeading = def('Report issues here, including the information below:')

export const helpHeading = def('Ask for help here:')

// The block the issue reporter is asked to paste. One message rather than four labels: which lines are present
// depends on what the instance knows about itself, and the omissions only read correctly as a whole.
export const versionInfo = def((info: { appVersion?: string; layersVersion?: string; username?: string; wsClientId?: string }) =>
	join(
		[
			info.appVersion !== undefined ? t('App Version: {appVersion}', { appVersion: info.appVersion }) : undefined,
			info.layersVersion !== undefined ? t('Layer Pool Version: {layersVersion}', { layersVersion: info.layersVersion }) : undefined,
			info.username !== undefined ? t('Logged in as: {username}', { username: info.username }) : undefined,
			info.wsClientId !== undefined ? t('WebSocket Client ID: {wsClientId}', { wsClientId: info.wsClientId }) : undefined,
		].filter((line) => line !== undefined),
	),
)

export const versionInfoCopied = def('Version information has been copied')

// -------- acknowledgements --------

export const acknowledgementsHeading = def('Acknowledgements')

// Prose rather than a label per person, so who is credited and what for reads as sentences a translator can rearrange.
// Each stays one string literal however long it runs: the extractor keys a message by a literal, and a concatenation
// leaves it out of the catalogue. The names below are the whole content of the section; edit them here.
export const acknowledgementsIntro = def(
	rt(
		'SLM is built and maintained by <strong>grey275</strong>, but it exists because of the <strong>TacTrig</strong> community. These are the people who made significant contributions to it.',
	),
)

export const acknowledgementsZero = def(
	rt(
		"<strong>Zero</strong>, for kicking the project off, and for his incredible work building out the layer scoring system that is integral to SLM. Our discussions also shaped much of the early feature set, which became some of SLM's defining characteristics. Without his effort this project wouldn't have been feasible.",
	),
)

export const acknowledgementsRandyNewman = def(
	rt(
		'<strong>Randy Newman</strong>, instrumental in getting SLM into the TacTrig admin workflow by making hardware available for deployment and writing approachable documentation. He graciously put up with my constant feature additions, which made his job harder at every turn.',
	),
)

export const acknowledgementsContributorsIntro = def(
	"Thank you to everyone below, who helped me not just with bugs but with feature requests and suggestions too. You had a real hand in shaping SLM's feature set.",
)

export const acknowledgementsUsersIntro = def(
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

export const acknowledgedUsers = ['Arrow2', 'BitingWit', 'dexii', 'LonelyNinja', 'sniffles', 'TomClaz', 'Bosditch']

// -------- the nav bar --------

export const navServer = def('Server')

export const navCommands = def('Commands')

export const navFilters = def('Filters')
export const navHistory = def('History')
export const navTutorials = def('Tutorials')

export const navSettings = def('Settings')

export const exploreLayers = def('Explore Layers')

// the explore-layers dialog's own title, which names what is being picked rather than the action
export const layersDialogTitle = def('Layers')

export const userMenu = def('User menu')

// the nav bar's overflow menus: page links that no longer fit, and every page link once none fit
export const navMore = def('More')
export const navPages = def('Pages')
export const navLinks = def('Links')
export const switchServer = def('Switch server')

// -------- the phone layout --------

export const phoneMatches = def('Matches')
export const phoneQueue = def('Queue')
export const phoneTeams = def('Teams')
export const phoneActivity = def('Activity')
export const phoneHere = def('Here')
export const switchToDesktopSite = def('Switch to desktop site')
export const switchToMobileSite = def('Switch to mobile site')
export const desktopOnlyTitle = def('{page} is only available on the desktop site', (page: string) => ({ page }))
export const desktopOnlyBlurb = def(
	'The phone layout covers the server dashboard, the layer picker and Generate Vote. Everything else opens as the desktop page, which you can pinch and pan.',
)
export const backToServer = def('Back to the server')

export const logOut = def('Log Out')

export const setNickname = def('Set Nickname')

export const linkedSteamAccounts = def('Linked Steam Accounts')

export const permissions = def('Permissions')

export const normalizeTeams = def('Normalize Teams')

export const normalizeTeamsHint = def('Show team A on the left and team B on the right, instead of team 1 and team 2')

// -------- theme --------

export const language = def('Language')

// following the browser rather than pinning one
export const languageAuto = def('Automatic')

export const theme = def('Theme')

export const themeNames = { light: 'Light', dark: 'Dark', system: 'System' }

// -------- the simulation and connection banners --------

export const stopSimulating = def('Stop Simulating')

export const simulating = def('Simulating')

export const disconnectedFromServer = def('Disconnected from server')

export const connectingToServer = def('Connecting to server...')

// -------- the primary panel's tabs --------

export const queueTab = def('Queue ({count})', (count: number) => ({ count }))

export const teamsTab = def('Teams ({count})', (count: number) => ({ count }))

export const finishedEditing = def('Finished editing')

// -------- the servers index --------

export const managedServers = def('Managed Servers')

export const noServersAvailable = def('No servers available.')

export const somethingWentWrong = def('Something went wrong')

// -------- what a suspended subtree says while it waits --------
// The odd casing of "This page" mid-sentence is inherited from the noun phrase this was built around before the
// sentences were spelled out, and is preserved here rather than quietly corrected.

export type BoundarySubject = 'global-settings' | 'page'

const subjectNames: Record<BoundarySubject, TString> = {
	'global-settings': t('global settings'),
	page: t('This page'),
}

export const boundaryLoading = def(
	"{state, select, waiting {Loading {subject}…} slow {Still waiting on {subject}…} other {Reconnecting, {subject} will load once we're back…}}",
	(subject: BoundarySubject, state: 'waiting' | 'slow' | 'reconnecting') => ({ subject: subjectNames[subject], state }),
)

export const boundaryFailed = def(
	"{timedOut, select, yes {{subject} didn't load} other {{subject} failed}}",
	(subject: BoundarySubject, timedOut: boolean) => ({ subject: subjectNames[subject], timedOut: timedOut ? 'yes' : 'no' }),
)

export const boundaryTimedOutBlurb = def('The server never sent this data. It may be busy or in a bad state.')

export const retry = def('Retry')

export const routeSuspended = def('Route suspended, waiting on state…')
