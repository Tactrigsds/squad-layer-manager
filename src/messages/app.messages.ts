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
