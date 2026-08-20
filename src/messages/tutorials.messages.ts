import { def, rt } from '@/models/messages.models'

// Copy shared by every tutorial: the launcher, the completion notice, and the warnings shown before a run starts.
// A tutorial's own step copy lives beside it in src/messages/tutorials/.

export const viewportSizeWarning = def('Your SLM window is a bit small. Make it bigger before continuing for a better experience.')

export const deviceWarning = def('The tutorials are best followed on a desktop, with a mouse and keyboard.')

export const tutorialComplete = def((tutorial: string) => ({ richText: rt('Tutorial <em>{tutorial}</em> is complete!', { tutorial }) }))
