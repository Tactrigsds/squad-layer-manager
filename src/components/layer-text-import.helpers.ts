// Reading layers out of pasted or opened text: one layer per line, or a rotation in its YAML or plain-text exchange
// format (see RFMT). The format module pulls in the whole `yaml` package, so it is loaded on first use rather than
// with the page.
import React from 'react'

import { describeLayerLine, resolveLines } from '@/components/multi-layer-set-dialog.helpers'
import { assertNever } from '@/lib/type-guards'
import * as Zus from '@/lib/zustand'
import * as ROT_Msgs from '@/messages/rotations.messages'
import type * as LL from '@/models/layer-list.models'
import type * as LTag from '@/models/layer-tags.models'
import type * as RFMT from '@/models/rotation-format.models'
import * as LayerQueriesClient from '@/systems/layer-queries.client'
import { tr } from '@/systems/messages.client'
import * as RbacClient from '@/systems/rbac.client'
import * as RotationClient from '@/systems/rotation.client'
import * as SettingsClient from '@/systems/settings.client'

type RfmtModule = typeof RFMT
const RfmtStore = Zus.createStore<{ rfmt: RfmtModule | null }>(() => ({ rfmt: null }))
let rfmtLoading: Promise<void> | null = null

function loadRfmt() {
	rfmtLoading ??= import('@/models/rotation-format.models').then((rfmt) => RfmtStore.setState({ rfmt }))
	return rfmtLoading
}

// a tag label the text names but this SLM does not define: created, dropped, or mapped onto a configured tag
export type TagChoice = { type: 'create' } | { type: 'drop' } | { type: 'map'; tagId: LTag.TagId }

export type LineError = { lineNumber: number; text: string; reason: string | null }

export type LayerTextImport = ReturnType<typeof useLayerTextImport>

export function useLayerTextImport(opts: { installedMods?: readonly string[]; validateByDefault?: boolean }) {
	void loadRfmt()
	const rfmt = Zus.useStore(RfmtStore, (s) => s.rfmt)
	const [text, setText] = React.useState('')
	const [validate, setValidate] = React.useState(opts.validateByDefault ?? true)
	const [tagChoices, setTagChoices] = React.useState<ReadonlyMap<string, TagChoice>>(new Map())
	const configuredTags = Zus.useStore(SettingsClient.PublicSettingsStore, (s) => s?.layerTags ?? [])
	const canCreateTags = !RbacClient.useAccess('settings.global.upsertLayerTag')
	const { installedMods } = opts

	const parsed = React.useMemo(() => (rfmt && text.trim() ? rfmt.parse(text, { installedMods }) : null), [rfmt, text, installedMods])
	const lines = parsed && rfmt ? rfmt.layerLines(parsed) : []
	const knownIds = validate ? lines.flatMap((line) => (line.code === 'ok' ? [line.layer.id] : [])) : []
	const existsRes = LayerQueriesClient.useLayerExists(knownIds, { enabled: knownIds.length > 0, usePlaceholderData: true })
	const resolved = resolveLines(lines, validate, existsRes.data)
	const tagLabels = parsed && rfmt ? rfmt.tagLabels(parsed, configuredTags) : []
	const choiceFor = (label: string): TagChoice => tagChoices.get(label.toLowerCase()) ?? { type: canCreateTags ? 'create' : 'drop' }

	const errors: LineError[] = [
		...(parsed?.errors ?? []).map((error) => ({ lineNumber: error.line, text: error.text, reason: describeParseError(error) })),
		...resolved.errors.map((line) => ({ lineNumber: line.lineNumber, text: line.text, reason: describeLayerLine(line) })),
	].sort((a, b) => a.lineNumber - b.lineNumber)
	// the items every line of which can be used, which is what the add button counts
	const errorLines = new Set(errors.map((error) => error.lineNumber))
	const itemCount =
		parsed?.items.filter((item) =>
			(item.type === 'single' ? [item.single.line] : [item.line, ...item.choices.map((choice) => choice.line)]).every(
				(line) => !errorLines.has(line),
			),
		).length ?? 0
	const hasVotes = parsed?.items.some((item) => item.type === 'vote') ?? false
	const ready = !!parsed && itemCount > 0 && errors.length === 0 && !resolved.pending

	// the parsed items as new list items, creating the tags chosen for creation first. Null when that fails.
	async function buildItems(): Promise<LL.NewItem[] | null> {
		if (!ready || !parsed || !rfmt) return null
		const mapping = new Map<string, LTag.TagId>()
		const toCreate: string[] = []
		for (const { label, match } of tagLabels) {
			if (match) {
				mapping.set(label.toLowerCase(), match.id)
				continue
			}
			const choice = choiceFor(label)
			switch (choice.type) {
				case 'create':
					toCreate.push(label)
					break
				case 'map':
					mapping.set(label.toLowerCase(), choice.tagId)
					break
				case 'drop':
					break
				default:
					assertNever(choice)
			}
		}
		if (toCreate.length > 0) {
			const created = await RotationClient.Actions.createLayerTags(toCreate)
			if (!created) return null
			for (const [label, id] of created) mapping.set(label, id)
		}
		return rfmt.toNewItems(parsed, mapping)
	}

	return {
		parsed,
		format: parsed?.format,
		noteCount: parsed && rfmt ? rfmt.noteCount(parsed) : 0,
		itemCount,
		hasVotes,
		ready,
		errors,
		validate,
		setValidate,
		setText,
		reset: () => setText(''),
		tagLabels,
		configuredTags,
		canCreateTags,
		choiceFor,
		setChoice: (label: string, choice: TagChoice) => setTagChoices((prev) => new Map(prev).set(label.toLowerCase(), choice)),
		buildItems,
	}
}

function describeParseError(error: RFMT.ParseError): string {
	switch (error.code) {
		case 'err:yaml':
			return tr.text(ROT_Msgs.yamlError(error.text))
		case 'err:not-a-list':
			return tr.text(ROT_Msgs.notAList())
		case 'err:bad-item':
			return tr.text(ROT_Msgs.badItem())
		case 'err:bad-vote-header':
			return tr.text(ROT_Msgs.badVoteHeader())
		default:
			assertNever(error.code)
	}
}

// the notes of `items`, taken off them: on a queue, notes can only be added as the adding user's own
export function splitNotes(items: LL.NewItem[]): { items: LL.NewItem[]; notes: { itemId: LL.ItemId; text: string }[] } {
	const notes: { itemId: LL.ItemId; text: string }[] = []
	const strip = <T extends { itemId?: LL.ItemId; notes?: { text: string }[] }>(item: T): T => {
		if (!item.notes || item.notes.length === 0) return item
		for (const note of item.notes) if (item.itemId) notes.push({ itemId: item.itemId, text: note.text })
		const { notes: _notes, ...rest } = item
		return rest as T
	}
	const out = items.map((item): LL.NewItem =>
		item.type === 'single-list-item' ? strip(item) : { ...item, choices: item.choices.map(strip) },
	)
	return { items: out, notes }
}
