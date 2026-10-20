import { def, rt, t, type Variants } from '@/models/messages.models'
import type * as TUT from '@/models/tutorial.models'

// Copy shared by every tutorial: the launcher, the completion notice, and the warnings shown before a run starts.
// A tutorial's own step copy lives beside it in src/messages/tutorials/.

export const viewportSizeWarning = def('Your SLM window is a bit small. Make it bigger before continuing for a better experience.')

export const deviceWarning = def('The tutorials are best followed on a desktop, with a mouse and keyboard.')

export const tutorialComplete = def((tutorial: string) => rt('Tutorial <em>{tutorial}</em> is complete!', { tutorial }))

// The index page: the list of tutorials and the controls for starting, resuming and leaving a run.
export const pageTitle = def('Tutorials')
export const duration = def((minutes: number) => t('{minutes} min', { minutes }))
export const start = def('Start')
export const startAgain = def('Start again')
export const resume = def('Resume')
export const replay = def('Replay')
export const leave = def('Leave')
export const completed = def('Completed')
export const inProgress = def('In progress')
export const noneAvailable = def('No tutorials are available on this install.')
// standing up a run's server, which takes a while: on the button pressed, and on a card shown wherever the reader is
export const settingUpShort = def('Setting up…')
export const settingUp = def('Setting up the {tutorial} tutorial…', (tutorial: string) => ({ tutorial }))

// The dialog a page opens with the tutorials it recommends. Dismissing it is per user and permanent, so the
// wording has to be clear that this is the last time it asks.
export const recommendedTitle = def((page: string) => t('Tutorials for the {page}', { page }))
export const recommendedBlurb = def("It's recommended that you complete these tutorials:")
export const dontShowAgain = def("Don't show this again")
export const notNow = def('Not now')

// What a page is called in that dialog's title, keyed by surface id.
export const surfaces = {
	'server-dashboard': def('server dashboard'),
}

// A tutorial's name, its one-line summary and its chapter names, keyed by scenario id and chapter id. The server
// advertises which scenarios exist and how long each takes, and TUT.CHAPTERS orders the chapters; what they are
// called is copy, so it lives here.
export const scenarios = {
	'layer-queue': {
		name: def('The layer queue'),
		summary: def('Learn the basics of queue editing.'),
		chapters: {
			'getting-started': def('Getting started'),
			'reading-the-queue': def('Reading the queue'),
			'layer-details': def('Layer details'),
			'finding-layers': def('Finding layers'),
			'choosing-layers': def('Choosing layers'),
			'editing-items': def('Editing items'),
			saving: def('Saving'),
			'generation-and-pool': def('Generation and the pool'),
			'repeat-rules': def('Repeat rules'),
			'next-layer-settings': def('Next layer settings'),
		},
	},
	'player-management': {
		name: def('Player management'),
		summary: def('Find, warn, kick, time out and move players.'),
		chapters: {
			'server-activity': def('Server activity'),
			'match-history': def('Match history'),
			'teams-panel': def('The teams panel'),
			'teams-breakdown': def('Teams breakdown'),
			'finding-players': def('Finding players'),
			'player-details': def('Player details and warnings'),
			'kicks-and-timeouts': def('Kicks and timeouts'),
			'team-swaps': def('Team swaps'),
			'switch-requests': def('Switch requests'),
		},
	},
} satisfies {
	[S in TUT.ScenarioId]: {
		name: () => Variants.Textable
		summary: () => Variants.Textable
		chapters: Record<TUT.ChapterId<S>, () => Variants.Textable>
	}
}

export function chapterName(scenarioId: TUT.ScenarioId, chapterId: string): Variants.Textable {
	return (scenarios[scenarioId].chapters as Record<string, () => Variants.Textable>)[chapterId]()
}

// the index page's list of a tutorial's chapters, each of which starts the tutorial from that chapter
export const chapters = def('Chapters')
export const startFromChapter = def('Start from this chapter')

// -------- the step card and its navigation --------

// the card shown between the last step of a chapter and the first step of the next
export const chapterComplete = def('Chapter complete')
export const upNext = def('Up next: {chapter}', (chapter: string) => ({ chapter }))
export const continueTutorial = def('Continue')
export const stopHere = def('Stop here')

export const stepFailedBlurb = def('That step could not be set up. Retry, or exit the tutorial.')

export const exit = def('Exit')

export const preparing = def('Preparing…')

export const finish = def('Finish')

export const navigation = def('Tutorial navigation')

export const contents = def('Contents')

export const previousStep = def('Previous step')

export const resetStep = def('Reset this step')

export const nextStep = def('Next step')

export const tableOfContents = def('Tutorial contents')

export const searchSteps = def('Search steps')

export const paused = def(() => rt('<strong>Tutorial paused.</strong> Return to the dashboard to continue where you left off.'))

export const backToDashboard = def('Back to dashboard')
