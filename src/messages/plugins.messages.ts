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

export const apiVersionLabel = def('slm api {range}', (range: string) => ({ range }))

export const apiVersionProvided = def('This build provides slm api {version}.', (version: string) => ({ version }))

export const enableLabel = def('{name} enabled', (name: string) => ({ name }))

export const configEditorModeLabel = def('{name} configuration editor', (name: string) => ({ name }))

export const saveConfig = def('Save')

export const discardConfig = def('Discard')

export const configSaved = def('{name} configuration saved', (name: string) => ({ name }))

export const configInvalid = def('The configuration is not valid.')

export const actionFailed = def('The request failed. Check the server logs.')

export const clientUpdated = def('{name} was updated. Reload to run the new version.', (name: string) => ({ name }))

export const reload = def('Reload')

export const installTitle = def('Install a plugin')

export const installBlurb = def('Paste the url of a plugin.json. SLM downloads it into its plugins folder and runs the local copy.')

export const installPlaceholder = def('https://example.com/my-plugin/plugin.json')

export const install = def('Install')

export const installed = def('{name} installed', (name: string) => ({ name }))

export const installFailed = def('Install failed')

export const refresh = def('Refresh')

export const refreshed = def('{name} re-fetched from its source', (name: string) => ({ name }))

export const rescan = def('Rescan folder')

export const rescanned = def('Plugins folder rescanned')

export const uninstall = def('Uninstall')

export const uninstalled = def('Plugin removed')

export const uninstallConfirm = def('Remove {name}? Its settings and data are kept.', (name: string) => ({ name }))

export const leftoverTitle = def('Leftover data')

export const leftoverBlurb = def(
	"Uninstalling keeps a plugin's settings and data so reinstalling restores them. Nothing else removes them.",
)

export const leftoverSummary = def(
	'{tables, plural, one {# table} other {# tables}}, {rows, plural, one {# row} other {# rows}}',
	(tables: number, rows: number) => ({ tables, rows }),
)

export const deleteData = def('Delete data')

export const deleteDataConfirm = def(
	"Permanently delete {name}'s settings and {tables, plural, one {# table} other {# tables}}? This cannot be undone.",
	(name: string, tables: number) => ({ name, tables }),
)

export const dataDeleted = def('{name} data deleted', (name: string) => ({ name }))

export const sourceLabels = {
	builtin: def('Built in'),
	directory: def('From folder'),
	url: def('Installed'),
}
