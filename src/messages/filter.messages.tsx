// see settings.messages.tsx on why a messages module with a react target keeps React in scope
import * as React from 'react'

import { assertNever } from '@/lib/type-guards'
import * as Msgs from '@/messages/shared'
import type * as F from '@/models/filter.models'

// The operator vocabulary the filter editor shows. Keyed by operator rather than target, so these are plain
// lookups rather than messages: the colloquial reading leads and the operation it names follows in parens,
// which is what makes the negated pair (nor/nand) legible.
export const blockTypeNames: Record<F.BlockType, string> = {
	and: 'all of (and)',
	or: 'any of (or)',
	nor: 'none of (nor)',
	nand: 'not all of (nand)',
}

export const blockTypeDescriptions: Record<F.BlockType, string> = {
	and: 'Matches layers where every condition in this block matches.',
	or: 'Matches layers where at least one condition in this block matches.',
	nor: 'Matches layers where not a single condition in this block matches.',
	nand: 'Matches layers where at least one condition in this block fails.',
}

export const applyFilterTypeNames: Record<F.ApplyFilterType, string> = {
	'included-in': 'included in',
	'excluded-from': 'excluded from',
}

export const applyFilterTypeDescriptions: Record<F.ApplyFilterType, string> = {
	'included-in': 'Matches layers that the referenced filter matches.',
	'excluded-from': 'Matches layers that the referenced filter does not match.',
}

export const matchupTypeNames: Record<F.MatchupType, string> = {
	'allow-matchups': 'allow matchups',
	'disallow-matchups': 'disallow matchups',
}

// Why a filter tree would not compile. Each one is attached to the node that caused it and rendered against that
// node in the editor, so they are `text` rather than `toast`.

export const recursiveFilter = Msgs.def('Filter is mutually recursive via filter: {filterId}', (filterId: string) => ({ filterId }))

export const unknownFilter = Msgs.def("Filter {filterId} doesn't exist", (filterId: string) => ({ filterId }))

export const unhandledNodeType = Msgs.def('Unhandled filter node type')

export const firstOperandMustBeColumn = Msgs.def("A comparison's first operand must be a column")

export const needsColumnOperand = Msgs.def('Comparison requires at least one column operand')

export const columnsNotComparable = Msgs.def(
	'Columns {left} and {right} are not comparable (different data types)',
	(left: string, right: string) => ({ left, right }),
)

export const orderedComparisonNull = Msgs.def('Ordered comparison cannot use null')

export const rangeComparisonNull = Msgs.def('Range comparison cannot use null')

export const unresolvedTeamColumn = Msgs.def('Team column "{column}" could not be resolved to a team', (column: string) => ({ column }))

export const unmappedColumn = Msgs.def('Column {column} is not mapped', (column: string) => ({ column }))

export const unmappedValue = Msgs.def('Value {value} is not mapped for column {column}', (column: string, value: NonNullable<F.Value>) => ({
	value,
	column,
}))

// Editing a filter entity.

export const saved = Msgs.def(() => ({ toast: () => [Msgs.t('Filter saved')] }))

export const notFound = Msgs.def(() => ({ toast: () => [Msgs.t('Unable to save: Filter Not Found')] }))

export const created = Msgs.def(() => ({ toast: () => [Msgs.t('Filter created')] }))

export const invalid = Msgs.def(() => ({
	toast: () => [Msgs.t('Invalid filter'), { description: Msgs.t('Please check filter configuration') }],
}))

export const deleted = Msgs.def((name: string) => ({
	toast: () => [Msgs.t('Filter "{name}" deleted', { name })],
}))

// Declared here rather than imported from the filter-entity system, which is server-only. Widening it is what makes
// the call site fail to typecheck if the server grows a delete failure this does not name.
export type DeleteFailure =
	| { code: 'err:permission-denied' }
	| { code: 'err:cannot-delete-pool-filter' }
	| { code: 'err:filter-not-found' }
	| { code: 'err:filter-in-use'; referencingFilters: string[] }

export const deleteFailed = Msgs.def((name: string, failure: DeleteFailure) => {
	function blurb() {
		switch (failure.code) {
			case 'err:permission-denied':
				return 'You do not have permission to delete this filter'
			case 'err:cannot-delete-pool-filter':
				return 'Cannot delete a filter that is currently in use by the layer pool'
			case 'err:filter-in-use':
				return 'Filter is in use by ' + failure.referencingFilters.join(', ')
			case 'err:filter-not-found':
				return 'Filter not found'
			default:
				assertNever(failure)
		}
	}

	return { toast: () => [Msgs.t('Failed to delete filter "{name}"', { name }), { description: blurb() }] }
})

export const formatFailed = Msgs.def((reason: string) => ({
	toast: () => [Msgs.t('Unable to format: invalid json'), { description: reason }],
}))

// Someone else's edit landing on a filter you have open.

export const updatedBy = Msgs.def((name: string, editor: string) => ({
	toast: () => [Msgs.t('Filter {name} was updated by {editor}', { name, editor })],
}))

export const deletedBy = Msgs.def((name: string, editor: string) => ({
	toast: () => [Msgs.t('Filter {name} was deleted by {editor}', { name, editor })],
}))

// Contributors.

export const contributorAlreadyAdded = Msgs.def(() => ({ toast: () => [Msgs.t('Contributor already added')] }))

export const contributorNotFound = Msgs.def(() => ({ toast: () => [Msgs.t('Contributor not found')] }))

export const addContributorFailed = Msgs.def((reason: string) => ({
	toast: () => [Msgs.t('Failed to add contributor'), { description: reason }],
}))

// -------- the filter card --------

export const loadingEditor = Msgs.def('Loading editor…')

export const reformat = Msgs.def('Reformat')

export const resetFilter = Msgs.def('Reset Filter')

export const textTab = Msgs.def('Text')

export const builderTab = Msgs.def('Builder')

export const errorsHeading = Msgs.def('Errors')

export const filterHeading = Msgs.def('Filter')

// -------- one node --------

export const operatorPicker = Msgs.def('Operator')

export const modePicker = Msgs.def('mode')

export const columnPicker = Msgs.def('Column')

export const addColumnPlaceholder = Msgs.def('+ column')

export const valuePicker = Msgs.def('value')

export const filterPicker = Msgs.def('Filter')

export const nodeComment = Msgs.def('Node comment')

export const nodeCommentPlaceholder = Msgs.def('Comment. Links are clickable.')

export const compareToValue = Msgs.def('Compare to a constant value')

export const compareToColumn = Msgs.def('Compare to another column')

// the null chip a float column's `=` renders instead of a value editor
export const nullValue = Msgs.def('null')

export const whyOnlyNull = Msgs.def('Why only null?')

// The operators named in it are the syntax being explained, so they are part of the prose; the caller renders
// them as code.
export const floatEqNullOnly = Msgs.def(() => ({
	react: () =>
		Msgs.node(
			"This column holds decimal (floating-point) values, which can't be matched with exact equality. Tiny rounding differences make " +
				'<code>=</code> unreliable, so use a range (<code>[..]</code>) or <code>{lt}</code>/<code>{gt}</code> to compare magnitudes; ' +
				'<code>=</code> only checks whether the value is null.',
			{ lt: '<', gt: '>', ...Msgs.tags },
		),
}))

// between the two bounds of an inrange comparison
export const rangeTo = Msgs.def('to')

export const inSetNames = { in: 'in', notin: 'not in' }

export const inSetDescriptions = {
	in: 'Matches the listed layers.',
	notin: 'Matches every layer except the listed ones.',
}

export const selectLayers = Msgs.def('Select Layers')

export const editLayers = Msgs.def('Edit Layers')

// -------- matchups --------

// a locked matchup names the two slots; an unlocked one only knows they are opposite each other
export const matchupSideLabels = { lockedLeft: 'Team 1', lockedRight: 'Team 2', left: 'One side', right: 'Other side' }

export const swapSides = Msgs.def('Swap the two sides')

// the placeholder on a team-spec dimension, e.g. "any faction"
export const anyTeamColumn = Msgs.def('any {column}', (column: string) => ({ column: column.toLowerCase() }))

// -------- the filter editor page --------

export const save = Msgs.def('Save')

export const deleteAction = Msgs.def('Delete')

export const cancel = Msgs.def('Cancel')

export const create = Msgs.def('Create')

// on the editor page the owner's name follows inline; in the index it labels a badge beside it
export const ownerLabel = Msgs.def('Owner:')

export const ownerLine = Msgs.def('Owner: {owner}', (owner: string) => ({ owner }))

export const contributorsLabel = Msgs.def('Contributors:')

export const editDetails = Msgs.def('Edit Details')

export const cancelEditingDetails = Msgs.def('Cancel Editing Details')

// why the viewer may or may not edit this filter, one per way of holding (or not holding) the grant
export const accessOwner = Msgs.def('You are the owner of this filter')

export const accessContributor = Msgs.def('You are a contributor')

export const accessNone = Msgs.def("You don't have permission to modify this filter")

export const accessAllFilters = Msgs.def('You have write access to all filters')

export const showContributors = Msgs.def('Show Contributors')

export const contributorsHeading = Msgs.def('Contributors')

export const contributorsBlurb = Msgs.def('Users and Roles that can edit this filter')

export const usersHeading = Msgs.def('Users')

export const rolesHeading = Msgs.def('Roles')

export const searchUsers = Msgs.def('Search for a user...')

export const searchRoles = Msgs.def('Search for a role...')

export const matchIndicator = Msgs.def('Match Indicator')

export const missIndicator = Msgs.def('Miss Indicator')

export const confirmDeleteTitle = Msgs.def('Delete Filter')

export const confirmDeleteBlurb = Msgs.def('Are you sure you want to delete this filter?')

// -------- the filter index --------

export const filtersHeading = Msgs.def('Filters')

export const newFilter = Msgs.def('New Filter')

// -------- the applied-filters panel --------

export const scrollLeft = Msgs.def('Scroll left (double-click to go to start)')

export const scrollRight = Msgs.def('Scroll right (double-click to go to end)')

export const editExtraFilters = Msgs.def('Edit extra filters')

export const addExtraFilters = Msgs.def('Add Extra Filters')

export const disableAllFilters = Msgs.def('Disable all filters')

export const hideRepeats = Msgs.def('Hide Repeats')

export const hideRepeatsHint = Msgs.def('Hide layers which violate Repeat rules')

// -------- the layer filter menu --------

export const clearAll = Msgs.def('Clear All')

export const swapFactions = Msgs.def('Swap Factions')

export const clearOtherFilters = Msgs.def('Remove all other filters and select this one')

// -------- the constraint indicators --------

export const layerIndicators = Msgs.def('Layer indicators')

export const repeatsDetectedLabel = Msgs.def('Repeats Detected:')

export const matchingFiltersLabel = Msgs.def('Matching Filters:')

// Why a layer violates a repeat rule. `value` and `offset` are already rendered (the panel bolds them), so the
// message positions them rather than formatting them.
export const repeatDescriptor = Msgs.def((value: React.ReactNode, offset: React.ReactNode, matchCount: number) => ({
	react: () =>
		Msgs.node('{value} was played {offset} {matchCount, plural, one {match} other {matches}} prior', { value, offset, matchCount }),
}))

export const repeatShouldBeOver = Msgs.def((within: React.ReactNode) => ({
	react: () => Msgs.node('Should be > {within}', { within }),
}))

export const repeatWithin = Msgs.def((within: React.ReactNode) => ({
	react: () => Msgs.node('within {within}', { within }),
}))
