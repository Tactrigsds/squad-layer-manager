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

export const configSaved = def('{name} configuration saved', (name: string) => ({ name }))

export const actionFailed = def('The request failed. Check the server logs.')

export const clientUpdated = def('{name} was updated. Reload to run the new version.', (name: string) => ({ name }))

export const reload = def('Reload')

export const installTitle = def('Install a plugin')

export const installBlurb = def('Paste the url of a plugin.json. SLM downloads it into its plugins folder and runs the local copy.')

export const installPlaceholder = def('https://example.com/my-plugin/plugin.json')

export const install = def('Install')

export const installed = def('{name} installed', (name: string) => ({ name }))

export const installFailed = def('Install failed')

export const installIdTaken = def(
	'The plugin {id} is already installed from {source}. Uninstall that plugin first to replace it with this one.',
	(id: string, source: string) => ({ id, source }),
)

export const installIdTakenByFolder = def(
	'The plugin {id} is already installed from the plugins folder. Uninstall that plugin first to replace it with this one.',
	(id: string) => ({ id }),
)

export const installIdOverlaps = def(
	'The plugin {id} cannot be installed beside {other}: their ids are too alike for SLM to keep their data apart. Uninstall {other} and delete its data first.',
	(id: string, other: string) => ({ id, other }),
)

export const installDisabledInDemo = def(
	'Plugins cannot be installed on a demo. Anyone who reaches a demo signs in as an admin, so installing a plugin there would let anyone run code on the server.',
)

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

// The trigger, not the count: the string that was taken and what took it is the whole of what an admin acts on.
export const commandTriggerTaken = def(
	'The trigger "{trigger}" is already used by {owner}, so it does nothing here. Set a different one in this plugin\'s commands.',
	(trigger: string, owner: string) => ({ trigger, owner }),
)

export const commandsTitle = def('Commands')
