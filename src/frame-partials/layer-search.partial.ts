// The search box above the layer results. Typed text is read the way /reqlayer reads a request, and what it names is
// written into the filter menu's items, which stay the single source of the query's constraints. Advanced search
// edits those same items. The text a user typed is kept only while the items are still the ones it produced; once
// they change the box shows them written back as text, so the box and Advanced never disagree.
import type * as FRM from '@/lib/frame'
import * as RSel from '@/lib/reselect'
import * as Str from '@/lib/string-utils'
import * as Zus from '@/lib/zustand'
import * as BB from '@/models/backburner.models'
import * as CB from '@/models/constraint-builders.models'
import * as F from '@/models/filter.models'
import type * as LQY from '@/models/layer-queries.models'
import * as L from '@/models/layer.models'
import * as FilterEntityClient from '@/systems/filter-entity.client'

import * as LayerFilterMenuPrt from './layer-filter-menu.partial'

export type LayerSearchSlice = {
	text: string
	// the menu items `text` produced, compared by reference with the menu's current items
	textItems: Record<string, F.EditableCompNode> | null
	// filters named in the text. They narrow the results like any other search word and leave the applied filters alone
	filterIds: F.FilterEntityId[]
}

export type Store = { layerSearch: LayerSearchSlice } & LayerFilterMenuPrt.Store
export type Key = FRM.InstanceKeyOfState<Store>
export type KeyProp = { layerSearch: Key }

type Args = FRM.SetupArgs<object, Store>

export function initLayerSearch(args: Args) {
	Zus.toPartialSetter(args.set, 'layerSearch')({ text: '', textItems: null, filterIds: [] } satisfies LayerSearchSlice)
}

const TEAM_TEXT_COLUMNS = (['Alliance', 'Faction', 'Unit'] as const satisfies F.PhysicalTeamColumn[]).map(
	(column) => [F.resolveTeamColumn(column, 1), F.resolveTeamColumn(column, 2)] as const,
)

// The columns the text owns. Typing sets each one to what the text says, which clears one the text leaves out.
// Collection is set only when the text names one, so a dialog's starting collection survives a search that doesn't.
const TEXT_COLUMNS = ['Layer', 'Map', 'Gamemode', 'LayerVersion', 'Size', ...TEAM_TEXT_COLUMNS.flat()]

// the single value a comparison pins its column to, if it reads as a plain search word
function plainValue(comp: F.EditableCompNode | undefined): string | undefined {
	if (!comp || comp.neg) return undefined
	if (comp.type === 'eq') {
		const value = F.compValue(comp)
		return typeof value === 'string' ? value : undefined
	}
	if (comp.type === 'in') {
		const values = F.compValues(comp)
		return values?.length === 1 && typeof values[0] === 'string' ? values[0] : undefined
	}
	return undefined
}

// The menu items written back as search text, and whether any constraint the text owns could not be written.
// A Team 2 value with no Team 1 value beside it is unwritten too: read back, a lone team word lands on Team 1.
function itemsToText(items: Record<string, F.EditableCompNode>, filterIds: F.FilterEntityId[]) {
	const words: string[] = []
	const written = new Set<string>()
	const write = (column: string) => {
		const value = plainValue(items[column])
		if (value === undefined) return
		words.push(Str.normalizeForMatch(value))
		written.add(column)
	}
	if (plainValue(items.Layer) !== undefined) {
		write('Layer')
		// the layer string already names them
		for (const column of ['Map', 'Gamemode', 'LayerVersion']) written.add(column)
	} else {
		write('Map')
		write('Gamemode')
		write('LayerVersion')
	}
	write('Size')
	for (const [team1, team2] of TEAM_TEXT_COLUMNS) {
		write(team1)
		if (written.has(team1)) write(team2)
	}
	for (const filterId of filterIds) {
		const filter = FilterEntityClient.filterEntities.get(filterId)
		if (filter) words.push(Str.normalizeForMatch(filter.name))
	}
	const unwritten = TEXT_COLUMNS.some((column) => !written.has(column) && items[column] && F.editableCompHasValue(items[column]))
	return { text: words.join(' '), unwritten }
}

function resolve(text: string) {
	return BB.resolveSearchTokens({
		tokens: text.split(/\s+/),
		components: L.StaticLayerComponents,
		filterEntities: Array.from(FilterEntityClient.filterEntities.values(), (f) => ({ id: f.id, name: f.name })),
	})
}

export namespace Sel {
	const writtenBack = RSel.createSelector(
		[(state: Store) => state.filterMenu.menuItems, (state: Store) => state.layerSearch.filterIds],
		itemsToText,
	)

	function textIsSource(state: Store) {
		return state.layerSearch.textItems === state.filterMenu.menuItems
	}

	export function text(state: Store) {
		return textIsSource(state) ? state.layerSearch.text : writtenBack(state).text
	}

	// constraints set in Advanced search that the text cannot show, and that the next search typed will clear
	export function hasUnwrittenConstraints(state: Store) {
		return !textIsSource(state) && writtenBack(state).unwritten
	}

	const textErrors = RSel.createSelector([(state: Store) => state.layerSearch.text], (text) => resolve(text).errors)

	const NO_ERRORS: BB.TokenError[] = []
	// the words in the typed text that named nothing, or more than their column holds
	export function errors(state: Store) {
		return textIsSource(state) ? textErrors(state) : NO_ERRORS
	}

	export type Part = { key: string } & (
		| { type: 'item'; field: string; op: F.CompOpKey; values: string[] }
		| { type: 'filter'; filterId: F.FilterEntityId }
		| { type: 'error'; token: string }
	)

	// every constraint the search applies, for reading the search back while the box is not being edited
	export const parts = RSel.createSelector(
		[(state: Store) => state.filterMenu.menuItems, (state: Store) => state.layerSearch.filterIds, (state: Store) => errors(state)],
		(items, filterIds, errors): Part[] => {
			const out: Part[] = []
			for (const [field, comp] of Object.entries(items)) {
				if (!F.editableCompHasValue(comp)) continue
				const values = (F.compValues(comp) ?? [F.compValue(comp)])
					.filter((value): value is F.Value => value !== undefined && !F.isColumnListItem(value as F.InListItem))
					.map((value) => String(value))
				out.push({ key: 'item:' + field, type: 'item', field, op: F.compOpSelectionKey(comp), values })
			}
			for (const filterId of filterIds) out.push({ key: 'filter:' + filterId, type: 'filter', filterId })
			errors.forEach((error, i) => out.push({ key: `error:${i}:${error.token}`, type: 'error', token: error.token }))
			return out
		},
	)

	export function constraints(state: Store): LQY.Constraint[] {
		return state.layerSearch.filterIds.map((filterId) => CB.filterEntity('search-filter:' + filterId, filterId))
	}
}

export namespace Actions {
	export function setText(stores: KeyProp, text: string) {
		const state = Zus.getState(stores.layerSearch)
		const { parts } = resolve(text)
		const named = LayerFilterMenuPrt.menuItemsFromTemplate(
			BB.buildTemplateFilter({ ...parts, filterIds: [] }),
			state.filterMenu.colConfig,
		)
		const items = { ...state.filterMenu.menuItems }
		for (const column of TEXT_COLUMNS) {
			if (items[column] && named[column]) items[column] = named[column]
		}
		if (parts.collections.length > 0 && named.Collection) items.Collection = named.Collection
		const aligned = LayerFilterMenuPrt.alignTeamRowOperators(items)
		LayerFilterMenuPrt.Actions.setMenuItems({ filterMenu: stores.layerSearch }, aligned)
		Zus.toPartialStore(stores.layerSearch, 'layerSearch').setState({
			text,
			textItems: Zus.getState(stores.layerSearch).filterMenu.menuItems,
			filterIds: parts.filterIds,
		})
	}

	// clears every constraint the search shows, Advanced ones included, except the collection the dialog opened on
	export function clear(stores: KeyProp) {
		const state = Zus.getState(stores.layerSearch)
		const { emptyItems, menuItems } = state.filterMenu
		const items: Record<string, F.EditableCompNode> = { ...emptyItems }
		if (menuItems.Collection) items.Collection = menuItems.Collection
		LayerFilterMenuPrt.Actions.setMenuItems({ filterMenu: stores.layerSearch }, items)
		Zus.toPartialStore(stores.layerSearch, 'layerSearch').setState({
			text: '',
			textItems: Zus.getState(stores.layerSearch).filterMenu.menuItems,
			filterIds: [],
		})
	}

	// records the search as it stands once the user is done with the box
	export function commit(stores: KeyProp) {
		const text = Sel.text(Zus.getState(stores.layerSearch)).trim()
		if (!text) return
		SearchPrefsStore.setState((state) => ({
			searches: [text, ...state.searches.filter((search) => search !== text)].slice(0, SEARCH_HISTORY_MAX),
		}))
	}

	export function clearHistory() {
		SearchPrefsStore.setState({ searches: [] })
	}

	export function dismissTips() {
		SearchPrefsStore.setState({ tipsDismissed: true })
	}

	export function setAdvancedOpen(open: boolean) {
		SearchPrefsStore.setState({ advancedOpen: open })
	}
}

const SEARCH_HISTORY_KEY = 'layerSearchHistory:v1'
const SEARCH_TIPS_DISMISSED_KEY = 'layerSearchTipsDismissed:v1'
const ADVANCED_OPEN_KEY = 'layerSearchAdvancedOpen:v1'
const SEARCH_HISTORY_MAX = 5

function readSearchHistory(): string[] {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) ?? '[]')
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
	} catch {
		return []
	}
}

// The user's recent searches, newest first and shared by every server, whether they dismissed the search tips, and
// whether the desktop picker shows Advanced search beside the results
export const SearchPrefsStore = Zus.createStore<{ searches: string[]; tipsDismissed: boolean; advancedOpen: boolean }>(
	(_set, _get, store) => {
		store.subscribe((state, prev) => {
			if (state.searches !== prev.searches) localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(state.searches))
			if (state.tipsDismissed !== prev.tipsDismissed) localStorage.setItem(SEARCH_TIPS_DISMISSED_KEY, String(state.tipsDismissed))
			if (state.advancedOpen !== prev.advancedOpen) localStorage.setItem(ADVANCED_OPEN_KEY, String(state.advancedOpen))
		})
		return {
			searches: readSearchHistory(),
			tipsDismissed: localStorage.getItem(SEARCH_TIPS_DISMISSED_KEY) === 'true',
			// open until the user closes it, which keeps the layout people already know
			advancedOpen: localStorage.getItem(ADVANCED_OPEN_KEY) !== 'false',
		}
	},
)
