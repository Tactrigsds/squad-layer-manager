import { def, rt, t } from '@/models/messages.models'

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

// A tutorial's name and its one-line summary, keyed by scenario id. The server advertises which scenarios exist
// and how long each takes; what they are called is copy, so it lives here.
export const scenarios = {
	'layer-queue': {
		name: def('The layer queue'),
		summary: def('Learn the basics of queue editing.'),
	},
}
