import React from 'react'

import * as LayerSearchPrt from '@/frame-partials/layer-search.partial.ts'
import type * as SelectLayersFrame from '@/frames/select-layers.frame.ts'
import { useDebounced } from '@/hooks/use-debounce'
import * as Zus from '@/lib/zustand'
import * as F_Msgs from '@/messages/filter.messages'
import * as LC_Msgs from '@/messages/layer-columns.messages'
import * as BB from '@/models/backburner.models'
import * as F from '@/models/filter.models'
import * as LC from '@/models/layer-columns.models'
import * as L from '@/models/layer.models'
import { tr } from '@/systems/messages.client'

// The search box while it is being edited. The input is uncontrolled: it reads the search once as it mounts, and
// while the user types the store follows the input rather than the reverse.
export function useSearchInput(frameKey: SelectLayersFrame.Key) {
	const inputRef = React.useRef<HTMLInputElement>(null)
	const [initialText] = React.useState(() => LayerSearchPrt.Sel.text(Zus.getState(frameKey)))
	const onChange = React.useCallback((value: string) => LayerSearchPrt.Actions.setText({ layerSearch: frameKey }, value), [frameKey])
	const setTextDebounced = useDebounced({ delay: 150, onChange })

	// applies what is in the box now rather than waiting out the debounce, then records it
	const finish = React.useCallback(() => {
		const value = inputRef.current?.value ?? ''
		if (value !== LayerSearchPrt.Sel.text(Zus.getState(frameKey))) LayerSearchPrt.Actions.setText({ layerSearch: frameKey }, value)
		LayerSearchPrt.Actions.commit({ layerSearch: frameKey })
	}, [frameKey])

	const setInput = React.useCallback(
		(value: string) => {
			if (inputRef.current) inputRef.current.value = value
			LayerSearchPrt.Actions.setText({ layerSearch: frameKey }, value)
		},
		[frameKey],
	)

	// a click anywhere but the input would move focus out of it, and losing focus is what ends an edit
	const keepFocus = React.useCallback((e: React.MouseEvent) => {
		if (e.target !== inputRef.current) e.preventDefault()
	}, [])

	return { inputRef, initialText, setTextDebounced, finish, setInput, keepFocus }
}

// a typed word can be wrong twice in one search, so each error is keyed by its word and which occurrence it is
export function errorKeys(errors: BB.TokenError[]) {
	const seen = new Map<string, number>()
	return errors.map((error) => {
		const occurrence = (seen.get(error.token) ?? 0) + 1
		seen.set(error.token, occurrence)
		return { key: `${error.token}#${occurrence}`, error }
	})
}

// swaps a search word for the suggestion that replaced it, written the way it would be typed
export function replaceToken(text: string, token: string, suggestion: string) {
	const replacement = suggestion.replace(/\s+/g, '')
	return text
		.split(/(\s+)/)
		.map((word) => (word === token ? replacement : word))
		.join('')
}

const EXAMPLE_SEARCHES = ['goro raas', 'usa rgf', 'large', 'narva aas', 'usmc pla']

// the examples the search tips offer, minus any the loaded layer catalog does not know
export function exampleSearches() {
	return EXAMPLE_SEARCHES.filter(
		(example) =>
			BB.resolveSearchTokens({ tokens: example.split(' '), components: L.StaticLayerComponents, filterEntities: [] }).errors.length ===
			0,
	).slice(0, 4)
}

const TEAM_FIELDS = new Map(
	F.TEAM_COLUMNS.flatMap((column) => ([1, 2] as const).map((team) => [F.resolveTeamColumn(column, team), { column, team }] as const)),
)

// a team field names its dimension and its side ("Faction T1"), as the matchup's pickers do
export function partColumnName(field: string) {
	const team = TEAM_FIELDS.get(field)
	if (team) return tr.text(F_Msgs.teamColumnForTeam(tr.text(F_Msgs.teamColumnNames[team.column]), team.team))
	const colDef = LC.getColumnDef(field)
	return colDef ? tr.text(LC_Msgs.columnName(colDef)) : field
}
