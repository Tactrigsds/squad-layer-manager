// see settings.messages.tsx on why a messages module with a react target keeps React in scope
import * as React from 'react'

import { assertNever } from '@/lib/type-guards'
import type * as FR from '@/models/filter-references.models'
import type * as F from '@/models/filter.models'
import { def, raw, rt, t, type TString } from '@/models/messages.models'

// The operator vocabulary the filter editor shows. Keyed by operator rather than target, so these are plain
// lookups rather than messages: the colloquial reading leads and the operation it names follows in parens,
// which is what makes the negated pair (nor/nand) legible.
export const blockTypeNames: Record<F.BlockType, TString> = {
	and: t('all of (and)'),
	or: t('any of (or)'),
	nor: t('none of (nor)'),
	nand: t('not all of (nand)'),
}

export const blockTypeDescriptions: Record<F.BlockType, TString> = {
	and: t('Matches layers where every condition in this block matches.'),
	or: t('Matches layers where at least one condition in this block matches.'),
	nor: t('Matches layers where not a single condition in this block matches.'),
	nand: t('Matches layers where at least one condition in this block fails.'),
}

export const applyFilterTypeNames: Record<F.ApplyFilterType, TString> = {
	'included-in': t('included in'),
	'excluded-from': t('excluded from'),
}

export const applyFilterTypeDescriptions: Record<F.ApplyFilterType, TString> = {
	'included-in': t('Matches layers that the referenced filter matches.'),
	'excluded-from': t('Matches layers that the referenced filter does not match.'),
}

export const matchupTypeNames: Record<F.MatchupType, TString> = {
	'allow-matchups': t('allow matchups'),
	'disallow-matchups': t('disallow matchups'),
}

// Why a filter tree would not compile. Each one is attached to the node that caused it and rendered against that
// node in the editor.
//
// Targets rather than messages: a validation error travels inside the tree it describes, through the editor's own
// state, and only one surface ever renders it. A message would carry a `Dyn` on every surface, which is a union of
// an object and a function that immer's draft types cannot map.

export const recursiveFilter = (filterId: string) => t('Filter is mutually recursive via filter: {filterId}', { filterId })

export const unknownFilter = (filterId: string) => t("Filter {filterId} doesn't exist", { filterId })

export const unhandledNodeType = () => t('Unhandled filter node type')

export const firstOperandMustBeColumn = () => t("A comparison's first operand must be a column")

export const needsColumnOperand = () => t('Comparison requires at least one column operand')

export const columnsNotComparable = (left: string, right: string) =>
	t('Columns {left} and {right} are not comparable (different data types)', { left, right })

export const orderedComparisonNull = () => t('Ordered comparison cannot use null')

export const rangeComparisonNull = () => t('Range comparison cannot use null')

export const unresolvedTeamColumn = (column: string) => t('Team column "{column}" could not be resolved to a team', { column })

export const unmappedColumn = (column: string) => t('Column {column} is not mapped', { column })

export const unmappedValue = (column: string, value: NonNullable<F.Value>) =>
	t('Value {value} is not mapped for column {column}', { value, column })

// Editing a filter entity.

export const saved = def(() => ({ toast: [t('Filter saved')] }))

export const notFound = def(() => ({ toast: [t('Unable to save: Filter Not Found')] }))

export const created = def(() => ({ toast: [t('Filter created')] }))

export const invalid = def(() => ({
	toast: [t('Invalid filter'), { description: t('Please check filter configuration') }],
}))

export const deleted = def((name: string) => ({
	toast: [t('Filter "{name}" deleted', { name })],
}))

// Declared here rather than imported from the filter-entity system, which is server-only. Widening it is what makes
// the call site fail to typecheck if the server grows a delete failure this does not name.
export type DeleteFailure =
	| { code: 'err:permission-denied' }
	| { code: 'err:filter-not-found' }
	| { code: 'err:filter-in-use'; references: FR.Reference[] }

export const deleteFailed = def((name: string, failure: DeleteFailure) => {
	function blurb() {
		switch (failure.code) {
			case 'err:permission-denied':
				return t('You do not have permission to delete this filter')
			case 'err:filter-in-use':
				return t('{count, plural, one {# reference} other {# references}} to it have to be removed first', {
					count: failure.references.length,
				})
			case 'err:filter-not-found':
				return t('Filter not found')
			default:
				assertNever(failure)
		}
	}

	return { toast: [t('Failed to delete filter "{name}"', { name }), { description: blurb() }] }
})

export const cyclicalReference = def((cycle: string[]) => ({
	toast: [t('Filters cannot reference each other in a loop'), { description: raw(cycle.join(' -> ')) }],
}))

export const cyclicalReferenceBlurb = def('Filters cannot reference each other in a loop: {cycle}', (cycle: string) => ({ cycle }))

export const formatFailed = def((reason: string) => ({
	toast: [t('Unable to format: invalid json'), { description: raw(reason) }],
}))

// Someone else's edit landing on a filter you have open.

export const updatedBy = def((name: string, editor: string) => ({
	toast: [t('Filter {name} was updated by {editor}', { name, editor })],
}))

export const deletedBy = def((name: string, editor: string) => ({
	toast: [t('Filter {name} was deleted by {editor}', { name, editor })],
}))

// Contributors.

export const contributorAlreadyAdded = def(() => ({ toast: [t('Contributor already added')] }))

export const contributorNotFound = def(() => ({ toast: [t('Contributor not found')] }))

export const addContributorFailed = def((reason: string) => ({
	toast: [t('Failed to add contributor'), { description: raw(reason) }],
}))

// -------- the filter card --------

export const loadingEditor = def('Loading editor…')

export const reformat = def('Reformat')

export const resetFilter = def('Reset Filter')

export const textTab = def('Text')

export const builderTab = def('Builder')

export const errorsHeading = def('Errors')

export const filterHeading = def('Filter')

// -------- one node --------

export const operatorPicker = def('Operator')

export const modePicker = def('mode')

export const columnPicker = def('Column')

export const addColumnPlaceholder = def('+ column')

export const valuePicker = def('value')

export const filterPicker = def('Filter')

// the "+" that reveals the kinds of condition a block can take
export const addCondition = def('Add condition')

export const nodeComment = def('Node comment')

export const nodeCommentPlaceholder = def('Comment. Links are clickable.')

export const compareToValue = def('Compare to a constant value')

export const compareToColumn = def('Compare to another column')

// the null chip a float column's `=` renders instead of a value editor
export const nullValue = def('null')

export const whyOnlyNull = def('Why only null?')

// The operators named in it are the syntax being explained, so they are part of the prose; the caller renders
// them as code.
export const floatEqNullOnly = def(() => ({
	richText: rt(
		"This column holds decimal (floating-point) values, which can't be matched with exact equality. Tiny rounding differences make <code>=</code> unreliable, so use a range (<code>[..]</code>) or <code>{lt}</code>/<code>{gt}</code> to compare magnitudes; <code>=</code> only checks whether the value is null.",
		{ lt: '<', gt: '>' },
	),
}))

// between the two bounds of an inrange comparison
export const rangeTo = def('to')

export const inSetNames = { in: 'in', notin: 'not in' }

export const inSetDescriptions = {
	in: 'Matches the listed layers.',
	notin: 'Matches every layer except the listed ones.',
}

export const selectLayers = def('Select Layers')

export const editLayers = def('Edit Layers')

// -------- matchups --------

// a locked matchup names the two slots; an unlocked one only knows they are opposite each other
export const matchupSideLabels = { lockedLeft: 'Team 1', lockedRight: 'Team 2', left: 'One side', right: 'Other side' }

export const swapSides = def('Swap the two sides')

// the placeholder on a team-spec dimension, e.g. "any faction"
export const anyTeamColumn = def('any {column}', (column: string) => ({ column: column.toLowerCase() }))

// -------- the filter editor page --------

export const save = def('Save')

export const deleteAction = def('Delete')

export const cancel = def('Cancel')

export const create = def('Create')

// on the editor page the owner's name follows inline; in the index it labels a badge beside it
export const ownerLabel = def('Owner:')

export const ownerLine = def('Owner: {owner}', (owner: string) => ({ owner }))

export const contributorsLabel = def('Contributors:')

export const editDetails = def('Edit Details')

export const cancelEditingDetails = def('Cancel Editing Details')

// why the viewer may or may not edit this filter, one per way of holding (or not holding) the grant
export const accessOwner = def('You are the owner of this filter')

export const accessContributor = def('You are a contributor')

export const accessNone = def("You don't have permission to modify this filter")

export const accessAllFilters = def('You have write access to all filters')

export const showContributors = def('Show Contributors')

export const contributorsHeading = def('Contributors')

export const contributorsBlurb = def('Users and Roles that can edit this filter')

export const usersHeading = def('Users')

export const rolesHeading = def('Roles')

export const searchUsers = def('Search for a user...')

export const searchRoles = def('Search for a role...')

export const matchIndicator = def('Match Indicator')

export const missIndicator = def('Miss Indicator')

export const confirmDeleteTitle = def('Delete Filter')

export const confirmDeleteBlurb = def('Are you sure you want to delete this filter?')

// -------- references --------

// Each names the pool-configuration list a filter is referenced from, as the pool config panels label it.
export const poolConfigKeyNames: Record<FR.PoolConfigKey, TString> = {
	poolFilter: t('Pool filter'),
	indicateMatches: t('Match indicators'),
	indicateMisses: t('Miss indicators'),
	defaultSelectable: t('Selectable filters'),
	warnFor: t('Warnings'),
	constrainGeneration: t('Generation constraints'),
}

export const referencesHeading = def('References')

export const noReferences = def('Nothing references this filter.')

export const referencingFiltersLabel = def('Filters:')

export const referencingPoolsLabel = def('Layer pools:')

// the apply-filter hops between a configured filter and this one, e.g. "via pool-base -> vehicles"
export const referenceVia = def('via {chain}', (chain: string) => ({ chain }))

export const referenceCount = def('{count, plural, one {# reference} other {# references}}', (count: number) => ({ count }))

export const deleteBlockedByReferences = def('This filter cannot be deleted while something references it')

// -------- the filter index --------

export const filtersHeading = def('Filters')

export const newFilter = def('New Filter')

// -------- the applied-filters panel --------

export const scrollLeft = def('Scroll left (double-click to go to start)')

export const scrollRight = def('Scroll right (double-click to go to end)')

export const editExtraFilters = def('Edit extra filters')

export const addExtraFilters = def('Add Extra Filters')

export const disableAllFilters = def('Disable all filters')

export const hideRepeats = def('Hide Repeats')

export const hideRepeatsHint = def('Hide layers which violate Repeat rules')

// -------- the layer filter menu --------

export const clearAll = def('Clear All')

export const swapFactions = def('Swap Factions')

export const clearOtherFilters = def('Remove all other filters and select this one')

// -------- the constraint indicators --------

export const layerIndicators = def('Layer indicators')

export const repeatsDetectedLabel = def('Repeats Detected:')

export const matchingFiltersLabel = def('Matching Filters:')

// Why a layer violates a repeat rule. `value` and `offset` are already rendered (the panel bolds them), so the
// message positions them rather than formatting them.
export const repeatDescriptor = def((value: React.ReactNode, offset: React.ReactNode, matchCount: number) => ({
	richText: rt('{value} was played {offset} {matchCount, plural, one {match} other {matches}} prior', { value, offset, matchCount }),
}))

export const repeatShouldBeOver = def((within: React.ReactNode) => ({
	richText: rt('Should be > {within}', { within }),
}))

export const repeatWithin = def((within: React.ReactNode) => ({
	richText: rt('within {within}', { within }),
}))
