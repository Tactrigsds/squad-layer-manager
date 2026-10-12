import { def, raw, t } from '@/models/messages.models'

// -------- the rotations page --------

export const pageTitle = def('Rotations')

export const pageBlurb = def(
	"A rotation is a saved, ordered list of layers and votes, with their tags and notes. Use Add Rotation on a server's queue to add one in a single step, or open one here to edit it with other admins.",
)

export const navRotations = def('Rotations')

export const newRotation = def('New Rotation')

export const searchPlaceholder = def('Search by name, description, map or faction')

export const searchLabel = def('Search rotations')

export const rotationTags = def('Rotation tags')

export const showArchived = def('Show archived')

export const sortModified = def('Last modified')

export const sortCreated = def('Date created')

export const sortName = def('Name')

export const shownCount = def('{shown} of {total} rotations', (shown: number, total: number) => ({ shown, total }))

export const noRotations = def('No rotations yet.')

export const noMatches = def('No rotation matches this search.')

export const itemCount = def('{count, plural, one {# item} other {# items}}', (count: number) => ({ count }))

export const moreItems = def('+ {count} more', (count: number) => ({ count }))

export const byOwner = def('by {owner}', (owner: string) => ({ owner }))

export const modifiedAgo = def('modified {ago}', (ago: string) => ({ ago }))

export const createdOn = def('created {date}', (date: string) => ({ date }))

export const archivedBadge = def('Archived')

// -------- actions on a rotation --------

export const clone = def('Clone')

export const linkCopied = def(() => ({ toast: [t('Link copied')] }))

export const archive = def('Archive')

export const unarchive = def('Unarchive')

export const deleteRotation = def('Delete')

export const deleteConfirmTitle = def('Delete {name}?', (name: string) => ({ name }))

export const deleteConfirmBody = def('Deleting a rotation cannot be undone. Layers already added to a queue from it stay where they are.')

export const deleted = def((name: string) => ({ toast: [t('Deleted {name}', { name })] }))

export const actionFailed = def((reason: string) => ({ toast: [t('Could not change the rotation'), { description: raw(reason) }] }))

// -------- creating and cloning --------

export const newRotationTitle = def('New Rotation')

export const cloneTitle = def('Clone Rotation')

export const cloneBlurb = def(
	'Clone copies the layers and description of {name}. The copy uses the same repeat ruleset, and you become its owner.',
	(name: string) => ({ name }),
)

export const name = def('Name')

export const id = def('ID')

export const idHelp = def('Follows the name until edited. Lowercase letters, numbers, hyphens and underscores.')

export const description = def('Description')

export const copyTags = def('Copy rotation tags')

export const copyContributors = def('Copy contributors')

export const contributors = def('Contributors')

export const contributorsBlurb = def('Users and roles that can edit this rotation, besides its owner')

export const create = def('Create')

export const cloneAndOpen = def('Clone and Open')

export const idTaken = def(() => ({ toast: [t('Another rotation already has this ID')] }))

// -------- the editor --------

export const ownerLabel = def('Owner: {owner}', (owner: string) => ({ owner }))

export const editName = def('Edit name')

export const editDescription = def('Edit description')

export const saveDetails = def('Save')

export const noDescription = def('No description.')

export const layers = def('Layers ({count})', (count: number) => ({ count }))

export const notFound = def('This rotation does not exist.')

export const updatedBy = def((name: string, editor: string) => ({ toast: [t('{editor} changed {name}', { name, editor })] }))

export const deletedBy = def((name: string, editor: string) => ({ toast: [t('{editor} deleted {name}', { name, editor })] }))

export const liveNobody = def('Nobody is editing')

export const liveEditors = def('{names} editing', (names: string) => ({ names }))

export const unsavedChanges = def('Unsaved changes')

export const unsavedChangesConfirm = def('This rotation has unsaved changes. Are you sure you want to leave?')

export const startEditing = def('Start Editing')

export const toggleForceSave = def('Toggle force save (Save even if others are still editing)')

export const saveHint = def('Save changes to the rotation')

export const finishEditingHint = def('Finish editing the rotation')

export const forceSaveHint = def('Save changes, even if others are still editing')

export const clearLayers = def('Clear layers')

export const repeatRuleset = def('Repeat ruleset')

export const repeatRulesetHelp = def(
	"The repeat ruleset that this rotation's layers are checked against. Saving its rules changes them for every server and rotation that uses it.",
)

// -------- export and import --------

export const exportButton = def('Export')

export const importButton = def('Import')

export const exportTitle = def('Export layers')

export const importTitle = def('Import layers')

export const formatYaml = def('YAML')

export const formatText = def('Plain text')

export const includeNotes = def('Notes')

export const includeTags = def('Tags')

export const download = def('Download')

export const copy = def('Copy')

export const copied = def('Copied to the clipboard')

export const nothingToExport = def('The rotation holds no layers to export.')

export const plainTextDropsTags = def(
	'Plain text leaves out the tags on {count, plural, one {# item} other {# items}}. Use YAML to keep them.',
	(count: number) => ({ count }),
)

export const importPlaceholder = def('Paste YAML or plain text. The format is detected.')

export const openFile = def('Open File...')

export const importSummary = def(
	'{format}: {items, plural, one {# item} other {# items}}, {notes, plural, one {# note} other {# notes}}',
	(format: string, items: number, notes: number) => ({ format, items, notes }),
)

export const tagMatches = def('Tag {label} matches an existing tag', (label: string) => ({ label }))

export const tagUnknown = def('Tag {label} is not defined on this SLM', (label: string) => ({ label }))

export const tagChoiceLabel = def('What to do with {label}', (label: string) => ({ label }))

export const tagCreate = def('Create it')

export const tagDrop = def('Drop it')

export const tagMapTo = def('Map to {label}', (label: string) => ({ label }))

export const importItems = def('{count, plural, =0 {Import} one {Import # Item} other {Import # Items}}', (count: number) => ({ count }))

export const yamlError = def('Not valid YAML: {message}', (message: string) => ({ message }))

export const notAList = def('A YAML import must be a list of items.')

export const badItem = def('Each item must be a layer line, a layer with tags, or a vote with at least one choice.')

export const badVoteHeader = def(
	'A vote line takes "display" followed by map, gamemode, layer, factions or units, and "duration" followed by a time such as 3m, separated by ";".',
)
