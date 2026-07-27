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

export const recursiveFilter = Msgs.def((filterId: string) => ({
	text: () => 'Filter is mutually recursive via filter: ' + filterId,
}))

export const unknownFilter = Msgs.def((filterId: string) => ({
	text: () => `Filter ${filterId} doesn't exist`,
}))

export const unhandledNodeType = Msgs.def(() => ({
	text: () => 'Unhandled filter node type',
}))

export const firstOperandMustBeColumn = Msgs.def(() => ({
	text: () => "A comparison's first operand must be a column",
}))

export const needsColumnOperand = Msgs.def(() => ({
	text: () => 'Comparison requires at least one column operand',
}))

export const columnsNotComparable = Msgs.def((left: string, right: string) => ({
	text: () => `Columns ${left} and ${right} are not comparable (different data types)`,
}))

export const orderedComparisonNull = Msgs.def(() => ({
	text: () => 'Ordered comparison cannot use null',
}))

export const rangeComparisonNull = Msgs.def(() => ({
	text: () => 'Range comparison cannot use null',
}))

export const unresolvedTeamColumn = Msgs.def((column: string) => ({
	text: () => `Team column "${column}" could not be resolved to a team`,
}))

export const unmappedColumn = Msgs.def((column: string) => ({
	text: () => `Column ${column} is not mapped`,
}))

export const unmappedValue = Msgs.def((column: string, value: NonNullable<F.Value>) => ({
	text: () => `Value ${value} is not mapped for column ${column}`,
}))

// Editing a filter entity.

export const saved = Msgs.def(() => ({ toast: () => ['Filter saved'] }))

export const notFound = Msgs.def(() => ({ toast: () => ['Unable to save: Filter Not Found'] }))

export const created = Msgs.def(() => ({ toast: () => ['Filter created'] }))

export const invalid = Msgs.def(() => ({
	toast: () => ['Invalid filter', { description: 'Please check filter configuration' }],
}))

export const deleted = Msgs.def((name: string) => ({
	toast: () => [`Filter "${name}" deleted`],
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

	return { toast: () => [`Failed to delete filter "${name}"`, { description: blurb() }] }
})

export const formatFailed = Msgs.def((reason: string) => ({
	toast: () => ['Unable to format: invalid json', { description: reason }],
}))

// Someone else's edit landing on a filter you have open.

export const updatedBy = Msgs.def((name: string, editor: string) => ({
	toast: () => [`Filter ${name} was updated by ${editor}`],
}))

export const deletedBy = Msgs.def((name: string, editor: string) => ({
	toast: () => [`Filter ${name} was deleted by ${editor}`],
}))

// Contributors.

export const contributorAlreadyAdded = Msgs.def(() => ({ toast: () => ['Contributor already added'] }))

export const contributorNotFound = Msgs.def(() => ({ toast: () => ['Contributor not found'] }))

export const addContributorFailed = Msgs.def((reason: string) => ({
	toast: () => ['Failed to add contributor', { description: reason }],
}))
