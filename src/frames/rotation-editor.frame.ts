import * as LayerQueuePrt from '@/frame-partials/layer-queue.partial'
import * as ListHostPrt from '@/frame-partials/list-host.partial'
import type * as FRM from '@/lib/frame'
import * as Rx from '@/lib/rxjs'
import { toast } from '@/lib/toast'
import { assertNever } from '@/lib/type-guards'
import * as Zus from '@/lib/zustand'
import * as ROT_Msgs from '@/messages/rotations.messages'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import type * as LTag from '@/models/layer-tags.models'
import * as L from '@/models/layer.models'
import * as RRS from '@/models/repeat-rulesets.models'
import type * as RFMT from '@/models/rotation-format.models'
import type * as ROT from '@/models/rotations.models'
import * as SETTINGS from '@/models/settings.models'
import * as LayerQueriesClient from '@/systems/layer-queries.client'
import { tr } from '@/systems/messages.client'
import * as RotationClient from '@/systems/rotation.client'
import * as SettingsClient from '@/systems/settings.client'

import { frameManager } from './frame-manager'

// The list host for one rotation's page: the shared draft of its items (edited with the queue's list editor) and the
// statuses shown on them. A rotation has no server, so it has no match history, and the catalog stands in for a
// server's settings; its repeat rules are those of its ruleset.
//
// The draft can also be edited as text, in either exchange format. Each pause in typing reads the text, and once
// every line of it can be used, replaces the whole draft with what it reads. Only text the user typed or opened is ever
// applied, so showing the text never writes to the draft. The text follows changes made to the draft some other way,
// such as another editor's edit, except while it holds typing that has not been applied yet.

export type Input = { rotationId: ROT.RotationId }

export type View = 'builder' | RFMT.Format

// a tag label the text names but this SLM does not define: dropped, or mapped onto a configured tag
export type TagChoice = { type: 'drop' } | { type: 'map'; tagId: LTag.TagId }

// what the text reads as, and what keeps it from being applied
export type SourceAnalysis = {
	itemCount: number
	noteCount: number
	parseErrors: RFMT.ParseError[]
	lineErrors: L.RawLayerLine[]
	// labels that match no tag, and those of them without a choice yet
	unmatchedTags: string[]
	unknownTags: string[]
	// still waiting on the layer database
	pending: boolean
}

export type Source = {
	text: string
	// bumped whenever the frame replaces the text, which the editor then takes up
	textSeq: number
	// the text holds what the user typed or opened, rather than what the frame wrote from the draft
	edited: boolean
	analysis: SourceAnalysis | null
}

export type State = ListHostPrt.Store & {
	rotationId: ROT.RotationId
	view: View
	source: Source
	tagChoices: ReadonlyMap<string, TagChoice>
	sourceEdits$: Rx.Subject<string>
	// mutated in place, never rendered: the serialization of the draft that the text last matched, and the analysis
	// in flight
	sourceRuntime: { synced: string; analysis: AbortController | null; pendingEdit: boolean }
}

export type Types = {
	name: 'rotationEditor'
	key: FRM.RawInstanceKey<{ rotationId: ROT.RotationId }>
	input: Input
	state: State
}

export type Key = FRM.InstanceKey<Types>
export type KeyProp = { rotationEditor: Key }
export type Frame = FRM.Frame<Types>
// what setup holds as well as what components hold
type StateKey = FRM.InstanceKeyOfState<State>

export function createInput(rotationId: ROT.RotationId): Input {
	return { rotationId }
}

const EDIT_DEBOUNCE_MS = 250

// the format module pulls in the whole `yaml` package, so it is loaded the first time text is shown
let rfmt: typeof RFMT | null = null
let rfmtLoading: Promise<typeof RFMT> | null = null
function loadRfmt() {
	rfmtLoading ??= import('@/models/rotation-format.models').then((mod) => (rfmt = mod))
	return rfmtLoading
}

export const frame: Frame = frameManager.createFrame<Types>({
	name: 'rotationEditor',
	createKey: (frameId, input) => ({ frameId, rotationId: input.rotationId }),
	setup(args) {
		const { rotationId } = args.input
		LayerQueuePrt.initLayerQueue(args, { type: 'rotation', rotationId })
		const sourceEdits$ = new Rx.Subject<string>()
		args.set({
			...ListHostPrt.INITIAL,
			rotationId,
			listHost: { type: 'rotation', rotationId },
			settings: { saved: SETTINGS.catalogSettings() },
			view: 'builder',
			source: { text: '', textSeq: 0, edited: false, analysis: null },
			tagChoices: new Map(),
			sourceEdits$,
			sourceRuntime: { synced: '', analysis: null, pendingEdit: false },
		})
		args.cleanup.push(sourceEdits$, () => args.get().sourceRuntime.analysis?.abort())

		const state$ = Zus.toObservable(args.key, true)
		const list$ = state$.pipe(
			Rx.map(([state]) => state.queue.layerList),
			Rx.distinctUntilChanged(),
		)
		args.cleanup.push(list$.subscribe((list) => args.set({ layerItemsState: LQY.resolveLayerItemsState(list, []) })))
		args.cleanup.push(list$.subscribe(() => syncSourceFromList(args.key)))
		args.cleanup.push(
			sourceEdits$
				.pipe(
					Rx.debounceTime(EDIT_DEBOUNCE_MS),
					Rx.switchMap((text) => Rx.from(analyzeAndApply(args.key, text))),
				)
				.subscribe(),
		)
		// a tag created or renamed elsewhere can resolve a label the text names
		args.cleanup.push(
			Zus.toStream(SettingsClient.PublicSettingsStore, (s) => s?.layerTags, { fireImmediately: false }).subscribe(() => {
				const state = args.get()
				if (state.view !== 'builder') void analyzeAndApply(args.key, state.source.text)
			}),
		)

		args.cleanup.push(
			Rx.combineLatest([
				Zus.toStream(RotationClient.Store, (s) => s.rotations.get(rotationId)?.repeatRulesetId ?? null, { fireImmediately: true }),
				Zus.toStream(SettingsClient.PublicSettingsStore, SettingsClient.selectRepeatRulesets, { fireImmediately: true }),
			]).subscribe(([repeatRulesetId, rulesets]) => args.set({ repeatRules: [...RRS.rulesFor(rulesets, repeatRulesetId)] })),
		)

		ListHostPrt.initStatuses(args)
	},
})

function store(key: StateKey) {
	return Zus.resolveStore<State>(key)
}

function runtimeOf(key: StateKey) {
	return Zus.getState(key).sourceRuntime
}

function configuredTags() {
	return SettingsClient.PublicSettingsStore.getState()?.layerTags ?? []
}

export function problemCount(analysis: SourceAnalysis | null): number {
	if (!analysis) return 0
	return analysis.parseErrors.length + analysis.lineErrors.length + analysis.unknownTags.length
}

// the problems that keep the view from being switched: those in text the user changed, which switching would lose
export function blockingProblems(source: Source): number {
	return source.edited ? problemCount(source.analysis) : 0
}

function writtenSource(prev: Source, text: string): Source {
	return { text, textSeq: prev.textSeq + 1, edited: false, analysis: null }
}

// replaces the text with the draft when the draft changed some other way than through the text. Typing that has not
// been applied yet is left alone.
function syncSourceFromList(key: StateKey) {
	const state = Zus.getState(key)
	if (state.view === 'builder' || !rfmt) return
	const text = rfmt.serialize(state.queue.layerList, state.view, configuredTags())
	const runtime = runtimeOf(key)
	if (text === runtime.synced) return
	if (state.source.edited && (runtime.pendingEdit || problemCount(state.source.analysis) > 0)) return
	runtime.synced = text
	store(key).setState({ source: writtenSource(state.source, text) })
	void analyzeAndApply(key, text)
}

// reads the text and, when every line of it can be used and it says something other than the draft, replaces the
// draft with it
async function analyzeAndApply(key: StateKey, text: string) {
	try {
		await analyzeAndApplyUnsafe(key, text)
	} catch (err) {
		console.error('reading the rotation text failed', err)
	}
}

async function analyzeAndApplyUnsafe(key: StateKey, text: string) {
	const runtime = runtimeOf(key)
	runtime.analysis?.abort()
	const controller = new AbortController()
	runtime.analysis = controller
	if (text === Zus.getState(key).source.text) runtime.pendingEdit = false
	const mod = rfmt ?? (await loadRfmt())
	const state = Zus.getState(key)
	if (controller.signal.aborted || state.view === 'builder') return
	const format = state.view

	const parsed = format === 'yaml' ? mod.parseYaml(text) : mod.parsePlainText(text)
	const lines = mod.layerLines(parsed)
	const knownIds = lines.flatMap((line) => (line.code === 'ok' ? [line.layer.id] : []))
	const tagLabels = mod.tagLabels(parsed, configuredTags())
	const unmatchedTags = tagLabels.flatMap(({ label, match }) => (match ? [] : [label]))
	const base = {
		itemCount: parsed.items.length,
		noteCount: mod.noteCount(parsed),
		parseErrors: parsed.errors,
		unmatchedTags,
		unknownTags: unmatchedTags.filter((label) => !state.tagChoices.has(label.toLowerCase())),
	}

	let resolved = L.resolveRawLayerLines(lines, true, [])
	if (knownIds.length > 0) {
		store(key).setState({ source: { ...Zus.getState(key).source, analysis: { ...base, lineErrors: resolved.errors, pending: true } } })
		let existence: { id: L.LayerId; exists: boolean }[]
		try {
			existence = await LayerQueriesClient.fetchLayersExist(knownIds, controller.signal)
		} catch (err) {
			if (controller.signal.aborted) return
			throw err
		}
		if (controller.signal.aborted) return
		resolved = L.resolveRawLayerLines(lines, true, existence)
	}
	const analysis: SourceAnalysis = { ...base, lineErrors: resolved.errors, pending: resolved.pending }
	store(key).setState({ source: { ...Zus.getState(key).source, analysis } })
	if (problemCount(analysis) > 0 || analysis.pending || !Zus.getState(key).source.edited) return

	const mapping = new Map<string, LTag.TagId>()
	for (const { label, match } of tagLabels) {
		if (match) {
			mapping.set(label.toLowerCase(), match.id)
			continue
		}
		const choice = state.tagChoices.get(label.toLowerCase())!
		switch (choice.type) {
			case 'map':
				mapping.set(label.toLowerCase(), choice.tagId)
				break
			case 'drop':
				break
			default:
				assertNever(choice)
		}
	}
	const list = Zus.getState(key).queue.layerList
	const items = mod.carryOver(list, mod.toNewItems(parsed, mapping), format)
	const unknownSource: LL.Source = { type: 'unknown' }
	const next = mod.serialize(
		items.map((item) => LL.createItem(item, unknownSource)),
		format,
		configuredTags(),
	)
	runtime.synced = next
	if (next === mod.serialize(list, format, configuredTags())) return
	await LayerQueuePrt.Actions.dispatch({ queue: key }, { op: 'add', ...LL.placementTarget(list, 'replace'), items })
}

export namespace Actions {
	// Shows the draft as text in `view`, or as the list. Leaving text that cannot be applied is refused, since what it
	// says would be lost.
	export async function setView(key: StateKey, view: View) {
		const state = Zus.getState(key)
		if (view === state.view || blockingProblems(state.source) > 0) return
		if (view === 'builder') {
			store(key).setState({ view })
			return
		}
		const mod = await loadRfmt()
		const text = mod.serialize(Zus.getState(key).queue.layerList, view, configuredTags())
		runtimeOf(key).synced = text
		store(key).setState({ view, source: writtenSource(Zus.getState(key).source, text) })
		void analyzeAndApply(key, text)
	}

	// an edit typed into the text, read once typing pauses
	export function editSource(key: StateKey, text: string) {
		const state = Zus.getState(key)
		state.sourceRuntime.pendingEdit = true
		store(key).setState({ source: { ...state.source, text, edited: true } })
		state.sourceEdits$.next(text)
	}

	// applies the text now rather than after the pause, for a save that must include the last keystrokes
	export async function flushSource(key: StateKey) {
		const state = Zus.getState(key)
		if (state.view === 'builder') return
		await analyzeAndApply(key, state.source.text)
	}

	// replaces the text with a file's, switching to the file's format
	export async function loadSource(key: StateKey, text: string) {
		const mod = await loadRfmt()
		const view = mod.detectFormat(text)
		const prev = Zus.getState(key).source
		store(key).setState({ view, source: { text, textSeq: prev.textSeq + 1, edited: true, analysis: null } })
		await analyzeAndApply(key, text)
	}

	// 'create' makes the tag right away, after which the label matches it
	export async function chooseTag(key: StateKey, label: string, choice: TagChoice | { type: 'create' }) {
		let resolved: TagChoice
		if (choice.type === 'create') {
			const created = await RotationClient.Actions.createLayerTags([label])
			const tagId = created?.get(label.toLowerCase())
			if (!tagId) return
			resolved = { type: 'map', tagId }
		} else {
			resolved = choice
		}
		const state = Zus.getState(key)
		store(key).setState({ tagChoices: new Map(state.tagChoices).set(label.toLowerCase(), resolved) })
		if (state.view !== 'builder') await analyzeAndApply(key, state.source.text)
	}

	export async function copyText(key: StateKey, format: RFMT.Format) {
		await navigator.clipboard.writeText(await exportText(key, format))
		toast(tr.text(ROT_Msgs.copied()))
	}

	export async function downloadText(key: StateKey, format: RFMT.Format) {
		const text = await exportText(key, format)
		const url = URL.createObjectURL(new Blob([text], { type: format === 'yaml' ? 'application/yaml' : 'text/plain' }))
		const a = document.createElement('a')
		a.href = url
		a.download = `${Zus.getState(key).rotationId}.${format === 'yaml' ? 'yaml' : 'txt'}`
		a.click()
		URL.revokeObjectURL(url)
	}
}

// the draft in `format`, or the text itself when it is shown in that format
async function exportText(key: StateKey, format: RFMT.Format): Promise<string> {
	const state = Zus.getState(key)
	if (state.view === format) return state.source.text
	const mod = await loadRfmt()
	return mod.serialize(state.queue.layerList, format, configuredTags())
}
