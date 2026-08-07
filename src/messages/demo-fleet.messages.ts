import { def } from '@/models/messages.models'

// The first-login role pick on a demo-fleet guild instance. It is shown once, to the first person holding Manage
// Server who signs in, and never again.
//
// TODO: placeholder copy, not signed off. See the app-text rule in CLAUDE.md.

export const roleSetupTitle = def('Choose who runs this instance')

export const roleSetupBlurb = def(
	'Everyone in your Discord server can sign in and look around. Pick the role that gets full access: the queue, the filters, the settings and the permissions.',
)

export const roleSetupNote = def('Anyone with Manage Server in Discord keeps full access whatever you pick here.')

export const roleSetupFieldLabel = def('Full-access role')

export const roleSetupConfirm = def('Grant full access')

export const roleSetupSaved = def('That role now has full access to this instance.')

export const roleSetupFailed = def('Could not set the role. Try again.')

export const roleSetupAlreadyChosen = def('Somebody else already chose a role for this instance.')
