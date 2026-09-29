import { def } from '@/models/messages.models'

// The What's new page, the menu item that leads to it, and the notice after an upgrade. The changelog entries
// themselves are written once in English, in the fragments, and are not translated.

export const pageTitle = def("What's new")
export const runningVersion = def(
	'{pending, plural, =0 {This server runs {version}.} one {This server runs {version} plus # newer change.} other {This server runs {version} plus # newer changes.}}',
	(version: string, pending: number) => ({ version, pending }),
)
export const searchPlaceholder = def('Search changes')
export const operatorNotes = def('Operator notes')
export const notifyMe = def('Notify me of new changes')
export const releasesHeading = def('Releases')
export const jumpTo = def('Jump to')

export const notYetReleased = def('Not yet in a release')
export const notYetReleasedShort = def('Not yet released')
export const notYetReleasedBlurb = def('Running here, but not in a release yet')
export const newCount = def('{count} new', (count: number) => ({ count }))
export const newEntry = def('New')
export const forOperators = def('For operators')
export const smallerChanges = def('{count, plural, one {# smaller change} other {# smaller changes}}', (count: number) => ({ count }))
export const tryTutorial = def('Try the tutorial')
export const copyLink = def('Copy a link to this change')
export const linkCopied = def('Link copied')
export const noMatches = def('No changes match your search.')
export const empty = def('Nothing has been recorded here yet.')
export const loadFailed = def("The changelog couldn't be loaded. Try reloading the page.")

export const kinds = {
	added: def('Added'),
	changed: def('Changed'),
	fixed: def('Fixed'),
	removed: def('Removed'),
	breaking: def('Breaking'),
}

// the account menu
export const menuItem = def("What's new")
export const accountMenuUnseen = def(
	'{count, plural, one {Account menu, # new change} other {Account menu, # new changes}}',
	(count: number) => ({ count }),
)

// shown once, on the first load after the page reloaded onto a new version
export const upgraded = def('SLM updated to {version}', (version: string) => ({ version }))
export const upgradedUnseen = def(
	"{count, plural, one {# change you haven't seen yet.} other {# changes you haven't seen yet.}}",
	(count: number) => ({ count }),
)
export const seeWhatsNew = def("See what's new")

export const versionHeading = def('Version')
export const aboutLink = def("What's new in this version")
