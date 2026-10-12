import React from 'react'

import { assertNever } from '@/lib/type-guards'
import * as MsgFmt from '@/messages/format'
import * as L_Msgs from '@/messages/layer.messages'
import * as L from '@/models/layer.models'
import * as LayerQueriesClient from '@/systems/layer-queries.client'
import { tr } from '@/systems/messages.client'

export type PastedLayers = {
	lines: L.RawLayerLine[]
	validate: boolean
	setValidate: (validate: boolean) => void
	setText: (text: string) => void
	reset: () => void
	errors: L.RawLayerLine[]
	layers: L.UnvalidatedLayer[]
	pending: boolean
}

// layers pasted in one per line, parsed as they are typed and, with validation on, checked against the layer database
export function usePastedLayers(installedMods: readonly string[] | undefined): PastedLayers {
	const [lines, setLines] = React.useState<L.RawLayerLine[]>([])
	const [validate, setValidate] = React.useState(true)
	const knownIds = validate ? lines.flatMap((line) => (line.code === 'ok' ? [line.layer.id] : [])) : []
	const existsRes = LayerQueriesClient.useLayerExists(knownIds, { enabled: knownIds.length > 0, usePlaceholderData: true })
	const { errors, layers, pending } = L.resolveRawLayerLines(lines, validate, existsRes.data)
	return {
		lines,
		validate,
		setValidate,
		setText: (text) => setLines(L.parseRawLayerLines(text, { installedMods })),
		reset: () => setLines([]),
		errors,
		layers,
		pending,
	}
}

// why a pasted line cannot be added
export function describeLayerLine(line: L.RawLayerLine) {
	switch (line.code) {
		case 'err:unparsable':
		case 'err:unknown-layer':
			if (line.problems.length === 0) return tr.text(L_Msgs.pasteErrorUnknownLayer())
			return MsgFmt.formatList(line.problems.map(describeProblem), { type: 'unit' })
		case 'err:mod-not-installed':
			return tr.text(L_Msgs.pasteErrorModNotInstalled(line.collection))
		case 'ok':
			return null
		default:
			assertNever(line)
	}
}

function describeProblem(problem: L.RawLayerProblem) {
	switch (problem.code) {
		case 'unknown-layer':
			return withSuggestion(tr.text(L_Msgs.pasteProblemUnknownLayer(problem.value)), problem.suggestion)
		case 'unknown-faction':
			return withSuggestion(tr.text(L_Msgs.pasteProblemUnknownFaction(problem.value, problem.team)), problem.suggestion)
		case 'unknown-unit':
			return withSuggestion(tr.text(L_Msgs.pasteProblemUnknownUnit(problem.value, problem.team)), problem.suggestion)
		case 'missing-faction':
			return tr.text(L_Msgs.pasteProblemMissingFaction(problem.team))
		case 'unavailable-faction': {
			const faction = problem.unit ? `${problem.faction}+${problem.unit}` : problem.faction
			return tr.text(L_Msgs.pasteProblemUnavailableFaction(faction, problem.team))
		}
		case 'mirror-matchup':
			return tr.text(L_Msgs.pasteProblemMirrorMatchup(problem.faction))
		default:
			assertNever(problem)
	}
}

function withSuggestion(text: string, suggestion: string | null) {
	return suggestion ? `${text} ${tr.text(L_Msgs.pasteProblemDidYouMean(suggestion))}` : text
}
