import { def } from '@/models/messages.models'

export const sectionTitle = def('Plugins')

export const sectionBlurb = def('Extensions that run inside SLM. Start, stop and configure them here.')

export const noPlugins = def('No plugins installed.')

export const statusLabels = {
	inactive: def('Stopped'),
	activating: def('Starting'),
	active: def('Running'),
	stopping: def('Stopping'),
	errored: def('Failed'),
}

export const enableLabel = def('{name} enabled', (name: string) => ({ name }))

export const saveConfig = def('Save')

export const discardConfig = def('Discard')

export const configSaved = def('{name} configuration saved', (name: string) => ({ name }))

export const configInvalid = def('The configuration is not valid.')

export const actionFailed = def('The request failed. Check the server logs.')
