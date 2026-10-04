import { useQuery } from '@tanstack/react-query'
import * as React from 'react'

import type * as SquadServerFrame from '@/frames/squad-server.frame'
import * as Gen from '@/lib/generator-utils'
import * as Obj from '@/lib/object-utils'
import * as RSel from '@/lib/reselect'
import * as Rx from '@/lib/rxjs'
import { toast } from '@/lib/toast'
import { assertNever } from '@/lib/type-guards'
import * as Zus from '@/lib/zustand'
import * as RPC_Msgs from '@/messages/rpc.messages'
import * as CB from '@/models/constraint-builders'
import * as CS from '@/models/context-shared'
import * as FB from '@/models/filter-builders'
import type * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as LQY from '@/models/layer-queries.models'
import * as LOGS from '@/models/logs'
import * as SETTINGS from '@/models/settings.models'
import * as RPC from '@/orpc.client'
import * as ConfigClient from '@/systems/config.client'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import * as LayerDataClient from '@/systems/layer-data.client'
import type * as WorkerTypes from '@/systems/layer-queries.worker'
// oxlint-disable-next-line import/default
import LQSharedWorker from '@/systems/layer-queries.worker?sharedworker'
// oxlint-disable-next-line import/default
import LQWorker from '@/systems/layer-queries.worker?worker'

export type Store = {
	// bumped whenever mutable state the worker holds (filter entities, generation weights) changes, invalidating
	// anything we cached against the old state
	backgroundStateEpoch: number
	incrementBackgroundStateEpoch: () => void
	hoveredConstraintItemId: string | null
	status: 'uninitialized' | 'initializing' | 'downloading-layers' | 'ready' | 'error'
	errorMessage: string | null
	setStatus: (status: 'initializing' | 'downloading-layers' | 'ready' | 'error', errorMessage?: string) => void
}

// we don't want to use the entire query context as query state so instead we just increment these counters whenever one of them change and depend on that instead
export const Store = Zus.createStore<Store>((set, get, store) => {
	return {
		backgroundStateEpoch: 0,
		hoveredConstraintItemId: null,
		incrementBackgroundStateEpoch() {
			set({ backgroundStateEpoch: get().backgroundStateEpoch + 1 })
		},
		status: 'uninitialized',
		errorMessage: null,
		setStatus(status, errorMessage) {
			set({ status, errorMessage: errorMessage ?? null })
		},
	}
})

export namespace Actions {
	export function setHoveredConstraintItemId(id: LQY.ItemId | null) {
		Store.setState({ hoveredConstraintItemId: id as string | null })
	}
}

// constraint values are raw matches (pre-inversion), index-aligned to constraints
function getIsLayerOutOfPool(constraintValues: boolean[], constraints: LQY.Constraint[]) {
	const index = constraints.findIndex((c) => c.type === 'filter-entity' && c.poolFilterMode)
	if (index === -1) return false
	const poolConstraint = constraints[index] as Extract<LQY.Constraint, { type: 'filter-entity' }>
	const matched = constraintValues[index] ?? false
	return poolConstraint.poolFilterMode === 'include' ? !matched : matched
}

// the installed-mods constraint matches the layers the server can load, so a false is the unsupported one. Absent
// constraint means nothing scoped the query to a server, which supports everything.
function getIsLayerUnsupported(constraintValues: boolean[], constraints: LQY.Constraint[]) {
	const index = constraints.findIndex((c) => c.type === 'installed-mods')
	if (index === -1) return false
	return !(constraintValues[index] ?? true)
}

export type ConstraintRowDetails = {
	values: boolean[]
	matchDescriptors: LQY.MatchDescriptor[]
	queriedConstraints: LQY.Constraint[]
	matchedConstraintDescriptors: LQY.MatchDescriptor[]
}
// isOutOfPool is pool membership alone. Whether that actually disables the row depends on queue:force-write, which is
// resolved in LayerTablePrt.Sel so it tracks the permissions dialog's simulation; baking it in here read the real
// permissions and left simulation with nothing to narrow.
export type RowData = L.KnownLayer &
	Record<string, any> & {
		constraints: ConstraintRowDetails
		isOutOfPool: boolean
		// the server has no mod for this layer's collection. Unlike isOutOfPool there is no permission that lifts it
		isUnsupported: boolean
	}
function layerToRowData(layer: any, queriedConstraints: LQY.Constraint[]): RowData {
	// TODO  this is madness
	const constraintValues = Array.isArray(layer.constraints) ? layer.constraints : (layer.constraints?.values ?? [])

	const matchDescriptors = Array.isArray(layer.matchDescriptors) ? layer.matchDescriptors : (layer.matchDescriptors ?? [])

	const matchedConstraintDescriptors = matchDescriptors

	const constraints: ConstraintRowDetails = {
		values: constraintValues,
		matchDescriptors,
		queriedConstraints,
		matchedConstraintDescriptors,
	}

	return {
		...layer,
		constraints,
		isOutOfPool: getIsLayerOutOfPool(constraintValues, queriedConstraints),
		isUnsupported: getIsLayerUnsupported(constraintValues, queriedConstraints),
	} as RowData
}

export type QueryLayersPageData = {
	layers: RowData[]
	totalCount: number
	pageCount: number
	input: LQY.LayersQueryInput
}

export type QueryLayersInputOpts = {
	cfg?: LQY.EffectiveColumnAndTableConfig
	selectedLayers?: L.LayerId[]
	sort?: LQY.LayersQueryInput['sort']
	pageSize?: number
	pageIndex?: number
}

export type QueryLayersPacket =
	| ({ code: 'layers-page' } & QueryLayersPageData)
	| { code: 'menu-item-possible-values'; values: Record<string, string[]> }

function toQueryLayersPacket(
	res: Exclude<WorkerTypes.QueryLayersResponse['payload'], { code: 'end' }>,
	input: LQY.LayersQueryInput,
): QueryLayersPacket {
	if (res.code === 'err:invalid-node') {
		console.error('queryLayers: Invalid node error:', res.errors)
		throw new Error('Invalid node')
	} else if (res.code === 'err:missing-item-states') {
		throw new Error('err:missing-item-states')
	}
	if (res.code === 'menu-item-possible-values') return res

	let page = {
		...res,
		input,
	}
	if (input.selectedLayers) {
		const layerIdsForPage = input.selectedLayers.slice(
			(input.pageIndex ?? 0) * input.pageSize,
			(input.pageIndex ?? 0) * input.pageSize + input.pageSize,
		)
		const selectedLayers: RowData[] = layerIdsForPage.map((id) => {
			const layer = page!.layers.find((l) => l.id === id)
			if (layer) {
				return layerToRowData(layer, input.constraints ?? [])
			}
			const newLayer: any = {
				...L.toLayer(id),
				constraints: Array(input.constraints?.length ?? 0).fill(false),
				matchDescriptors: [],
			}
			return layerToRowData(newLayer, input.constraints ?? [])
		})
		if (input.sort) {
			;(selectedLayers as Record<string, any>[]).sort((a: any, b: any) => {
				const sort = input.sort!
				if (sort.type === 'random') {
					// For random sort just shuffle the entries
					return Math.random() - 0.5
				} else if (sort.type === 'column') {
					const column = sort.sortBy
					const direction = sort.direction === 'ASC' ? 1 : -1

					if (a[column] === b[column]) return 0
					if (a[column] === null || a[column] === undefined) return direction
					if (b[column] === null || b[column] === undefined) return -direction

					return a[column] < b[column] ? -direction : direction
				} else {
					assertNever(sort)
				}
			})
		}
		page = { ...page, layers: selectedLayers as any }
	}
	return {
		...page,
		layers: page.layers?.map((layer: any) => layerToRowData(layer, input.constraints ?? [])),
	}
}

// replaces the react-query cache for layer page queries: each entry is a shared packet stream, so completed results
// replay synchronously and concurrent subscribers (e.g. prefetch + table) share one worker query
const queryLayersCache = new Map<string, Rx.Observable<QueryLayersPacket>>()
const QUERY_LAYERS_CACHE_MAX_ENTRIES = 50

// The query starts on the first subscribe. Once it completes it replays to later subscribers; until then, losing
// the last subscriber cancels it in the worker, and the next subscriber starts it over.
export function queryLayers$(input: LQY.LayersQueryInput): Rx.Observable<QueryLayersPacket> {
	const key = JSON.stringify(getDepKey(input, Store.getState().backgroundStateEpoch))
	const cached = queryLayersCache.get(key)
	if (cached) {
		// refresh the entry's insertion-order position so hot queries survive eviction
		queryLayersCache.delete(key)
		queryLayersCache.set(key, cached)
		return cached
	}
	const packet$: Rx.Observable<QueryLayersPacket> = workerRequest$('queryLayers', input).pipe(
		Rx.map((res) => toQueryLayersPacket(res, input)),
		Rx.tap({
			error: () => {
				if (queryLayersCache.get(key) === packet$) queryLayersCache.delete(key)
			},
		}),
		Rx.shareReplay({ bufferSize: Infinity, refCount: true }),
	)
	queryLayersCache.set(key, packet$)
	while (queryLayersCache.size > QUERY_LAYERS_CACHE_MAX_ENTRIES) {
		queryLayersCache.delete(queryLayersCache.keys().next().value!)
	}
	return packet$
}

// runs the query to completion so a later queryLayers$ for the same input replays it
export function prefetchLayersQuery(input: LQY.LayersQueryInput) {
	queryLayers$(input).subscribe({ error: () => {} })
}

export function getQueryLayersInput(baseInput: LQY.BaseQueryInput, _opts?: QueryLayersInputOpts): LQY.LayersQueryInput {
	const opts: QueryLayersInputOpts = _opts ?? {}
	let sort = opts.sort ?? opts.cfg?.defaultSortBy ?? LQY.DEFAULT_SORT
	if (sort?.type === 'random' && !sort.seed) {
		console.error('Random sort requires a random seed when used with react query')
		sort = { ...sort, seed: 'SUPER_RANDOM_SEED' }
	}
	const pageSize = opts.pageSize ?? LQY.DEFAULT_PAGE_SIZE
	const pageIndex = opts.pageIndex ?? 0
	const selectedLayers = opts.selectedLayers
	if (baseInput.cursor && !baseInput.action) {
		baseInput = { ...baseInput, action: 'add' }
	}

	if (selectedLayers) {
		const filter = FB.inValues(
			'id',
			selectedLayers.filter((layer) => LC.isKnownAndValidLayer(layer, opts.cfg)),
		)
		baseInput = {
			...baseInput,
			constraints: [...(baseInput.constraints?.filter((c) => !c.filterApplState) ?? []), CB.filterAnon('show-selected', filter)],
		}
	}

	return {
		...baseInput,
		pageIndex,
		sort,
		pageSize,
		selectedLayers: selectedLayers,
	}
}

export async function checkBackburnerTemplates(input: LQY.BaseQueryInput & { templates: { itemId: string; filter: F.FilterNode }[] }) {
	return await sendWorkerRequest('checkBackburnerTemplates', input)
}

export async function solveRepeatViolations(input: LQY.SolveRepeatViolationsInput) {
	return await sendWorkerRequest('solveRepeatViolations', input)
}

export async function generateVote(input: LQY.GenVote.Input) {
	const res = await sendWorkerRequest('genVote', input)
	if (res.code !== 'ok') return res
	const choiceRowData = res.chosenLayers.map((l) => (l ? layerToRowData(l, input.constraints ?? []) : undefined))
	return {
		...res,
		chosenLayers: choiceRowData,
	}
}

export function useLayerComponents(
	input: LQY.LayerComponentInput,
	options: { enabled?: boolean; errorStore?: Zus.StoreApi<F.NodeValidationErrorStore> } = {},
) {
	return useQuery({
		...options,
		queryKey: ['layers', 'queryLayerComponents', useDepKey(input)],
		enabled: options?.enabled,
		queryFn: async ({ signal }: { signal: AbortSignal }) => {
			const res = await sendWorkerRequest('queryLayerComponent', input, signal)
			if (Array.isArray(res)) return res
			if (res?.code === 'err:invalid-node') {
				console.error('queryLayerComponents: Invalid node error:', res.errors)
				options?.errorStore?.setState({ errors: res.errors })
				throw new Error(res.code + ': ' + JSON.stringify(res.errors))
			} else if (options.errorStore) {
				options.errorStore.setState({ errors: undefined })
			}
			return res
		},
		staleTime: Infinity,
	})
}

// built lazily: layer data has to be loaded before the catalog's collections can be read
let catalogWideSettings: SETTINGS.PublicServerSettings | undefined

export namespace Sel {
	// recomputed only when the saved settings change, rather than on every squad-server frame update
	export const layerItemStatusConstraints = RSel.createDeepSelector(
		[(state: SquadServerFrame.State | undefined | null) => state?.settings.saved],
		(saved) => SETTINGS.getSettingsConstraints(saved ?? (catalogWideSettings ??= SETTINGS.catalogSettings())),
	)
}

// squadServerFrameKey is optional so this can be used from contexts with no active squad-server (e.g. the filter editor)
export function useLayerItemStatusConstraints(squadServerFrameKey?: SquadServerFrame.Key) {
	return Zus.useStore(squadServerFrameKey ?? null, Sel.layerItemStatusConstraints)
}

function filterAndReportInvalidDescriptors(allConstraints: LQY.Constraint[], matchDescriptors: LQY.MatchDescriptor[] | undefined) {
	if (!matchDescriptors) return undefined

	const validDescriptors: LQY.MatchDescriptor[] = []
	for (let i = 0; i < matchDescriptors.length; i++) {
		if (!allConstraints.some((c) => c.id === matchDescriptors[i].constraintId)) {
			console.error(`Matched constraint ${matchDescriptors[i].constraintId} is not present in the system`)
		} else {
			validDescriptors.push(matchDescriptors[i])
		}
	}
	return validDescriptors.length > 0 ? validDescriptors : undefined
}
export type LayerItemStatusData = {
	present: Set<LQY.ItemId>
	queriedConstraints: LQY.Constraint[]
	matchingConstraintIds: string[]
	matchingDescriptors: LQY.MatchDescriptor[]
	highlightedMatchDescriptors?: LQY.MatchDescriptor[]
}

export function useLayerItemStatusData(
	layerItem: LQY.LayerItem | LQY.ItemId,
	squadServerFrameKey?: SquadServerFrame.Key,
): LayerItemStatusData | null {
	const queriedConstraints = useLayerItemStatusConstraints(squadServerFrameKey)
	const statuses = Zus.useStore(squadServerFrameKey, (s) => s?.layerItemStatuses)
	const itemId = LQY.resolveId(layerItem)

	const allMatchDescriptors = statuses?.matchDescriptors
	const presentLayers = statuses?.present

	const highlightedMatchDescriptors = Zus.useStore(
		Store,
		Zus.useDeep((store) => {
			if (!allMatchDescriptors) return
			const hoveredConstraintItemId = store.hoveredConstraintItemId ?? undefined
			const hoveredMatchDescriptors =
				(hoveredConstraintItemId &&
					hoveredConstraintItemId !== itemId &&
					filterAndReportInvalidDescriptors(
						queriedConstraints,
						allMatchDescriptors
							.get(hoveredConstraintItemId)
							?.filter((vd) => vd.type === 'repeat-rule' && vd.sourceItemId === itemId && vd.itemId !== undefined)
							.map((vd) => LQY.repeatDescriptorFromSourcePerspective(vd as LQY.RepeatMatchDescriptor & { itemId: LQY.ItemId })),
					)) ||
				undefined

			const localMatchDescriptors =
				(hoveredConstraintItemId === itemId &&
					filterAndReportInvalidDescriptors(queriedConstraints, allMatchDescriptors.get(itemId))) ||
				undefined

			return localMatchDescriptors ?? hoveredMatchDescriptors
		}),
	)

	return React.useMemo(() => {
		if (!allMatchDescriptors || !presentLayers) return null
		const matchingDescriptors = filterAndReportInvalidDescriptors(queriedConstraints, allMatchDescriptors.get(itemId)) ?? []

		const matchingConstraintIds = matchingDescriptors.map((c) => c.constraintId)

		return {
			present: presentLayers,
			queriedConstraints,
			matchingConstraintIds,
			matchingDescriptors,
			highlightedMatchDescriptors,
		}
	}, [highlightedMatchDescriptors, allMatchDescriptors, itemId, presentLayers, queriedConstraints])
}

export async function fetchLayersOutOfPool(
	input: { layerIds: L.LayerId[]; constraints: LQY.Constraint[] },
	signal?: AbortSignal,
): Promise<L.LayerId[] | null> {
	const res = await sendWorkerRequest('getLayersOutOfPool', input, signal)
	if (res.code !== 'ok') {
		console.error('getLayersOutOfPool:', res)
		return null
	}
	return res.outOfPool
}

// resolved reactively into the squad-server frame's layerItemStatuses state; not a query. Unsubscribing before the
// result arrives cancels the request in the worker.
export function layerItemStatuses$(input: LQY.LayerItemStatusesInput): Rx.Observable<LQY.LayerItemStatuses | null> {
	return workerRequest$('getLayerItemStatuses', input).pipe(
		Rx.map((res) => {
			if (res.code === 'err:invalid-node') {
				console.error('getLayerItemStatuses: Invalid node error:', res.errors)
				return null
			}
			if (res.code === 'err:missing-item-states') {
				console.error('getLayerItemStatuses: missing item states')
				return null
			}
			return res.statuses
		}),
	)
}

export async function fetchLayerItemStatuses(input: LQY.LayerItemStatusesInput): Promise<LQY.LayerItemStatuses | null> {
	return await Rx.firstValueFrom(layerItemStatuses$(input))
}

export function useLayerExists(input?: LQY.LayerExistsInput, options: { enabled?: boolean; usePlaceholderData?: boolean } = {}) {
	return useQuery({
		enabled: input && options.enabled !== false,
		placeholderData: options.usePlaceholderData ? (d) => d : undefined,
		queryKey: ['layers', 'layerExists', useDepKey(input)],
		queryFn: async ({ signal }: { signal: AbortSignal }) => {
			const res = await sendWorkerRequest('layerExists', input!, signal)
			if (res.code === 'err:missing-item-states') throw new Error('err:missing-item-states')
			return res.results
		},
		staleTime: Infinity,
	})
}

export function useDepKey(input?: unknown) {
	const backgroundStateEpoch = Zus.useStore(
		Store,
		Zus.useShallow((s) => s.backgroundStateEpoch),
	)
	return getDepKey(input, backgroundStateEpoch)
}

// maps each distinct layerItems array reference to a small id so query keys compare the list shallowly
// (by reference + parity) instead of stringifying ~100 layer items into every key on every render
const layerItemsKeyIds = new WeakMap<object, number>()
let layerItemsKeyIdCounter = 0
function listDepKey(list: LQY.LayerItemsState) {
	let id = layerItemsKeyIds.get(list.layerItems)
	if (id === undefined) {
		id = ++layerItemsKeyIdCounter
		layerItemsKeyIds.set(list.layerItems, id)
	}
	return { layerItemsRef: id, firstLayerItemParity: list.firstLayerItemParity }
}

// get context/input that may invalidate the query
function getDepKey(input: unknown, backgroundStateEpoch: number) {
	const list = (input as LQY.BaseQueryInput | undefined)?.list
	if (typeof input === 'object' && input !== null && list !== undefined) {
		input = { ...(input as LQY.BaseQueryInput), list: listDepKey(list) }
	}
	return {
		input,
		backgroundStateEpoch,
	}
}

type RequestType = WorkerTypes.RequestInner['type']
type RequestInput<T extends RequestType> = Extract<WorkerTypes.RequestInner, { type: T }>['input']
type ResponsePayload<T extends RequestType> = Exclude<Extract<WorkerTypes.ResponseInner, { type: T }>['payload'], { code: 'end' }>

// Lower runs first. The worker runs init, filter-update and generation-update as ordering barriers, so their priority
// is never compared. Queue statuses gate saving, so they go ahead of the layer table.
const QUERY_PRIORITIES: Record<RequestType, number> = {
	init: 0,
	'filter-update': 0,
	'generation-update': 0,
	getLayerItemStatuses: 1,
	getLayersOutOfPool: 1,
	queryLayerComponent: 2,
	layerExists: 2,
	getLayerInfo: 2,
	queryLayers: 3,
	genVote: 3,
	solveRepeatViolations: 3,
	checkBackburnerTemplates: 4,
}

const seqIdCounter = Gen.counter()
function getSeqId() {
	return seqIdCounter.next().value
}

// a MessagePort into the shared worker, or a dedicated worker where SharedWorker is unavailable
// (notably Chrome for Android); both expose the same postMessage/message surface
let worker!: Worker | MessagePort

// one listener routes every reply to the request that sent it
const responseHandlers = new Map<
	number,
	(response: Exclude<WorkerTypes.FromWorker, { type: 'worker-log' | 'layer-download-started' }>) => void
>()

// Posts the request on subscribe. Unsubscribing before the last reply cancels the request in the worker. A
// queryLayers request emits each packet and completes on the end packet; any other request emits its one payload.
function workerRequest$<T extends RequestType>(type: T, input: RequestInput<T>): Rx.Observable<ResponsePayload<T>> {
	const request$ = new Rx.Observable<ResponsePayload<T>>((subscriber) => {
		const seqId = getSeqId()
		let settled = false
		function settle() {
			settled = true
			responseHandlers.delete(seqId)
		}
		responseHandlers.set(seqId, (response) => {
			if (response.type === 'worker-error' || response.type !== type) {
				settle()
				const error = new Error(
					response.type === 'worker-error' ? 'error from worker: ' + response.error : `Unexpected response type: ${response.type}`,
				)
				toast.error(error.message)
				subscriber.error(error)
				return
			}
			const payload = response.payload as ResponsePayload<T> | { code: 'end' }
			if (type === 'queryLayers' && (payload as { code: string }).code !== 'end') {
				subscriber.next(payload as ResponsePayload<T>)
				return
			}
			// settled before emitting: a first() downstream unsubscribes on next, which must not read as a cancel
			settle()
			if (type !== 'queryLayers') subscriber.next(payload as ResponsePayload<T>)
			subscriber.complete()
		})
		worker.postMessage({ type, input, seqId, priority: QUERY_PRIORITIES[type] } as WorkerTypes.ToWorker)
		return () => {
			if (settled) return
			responseHandlers.delete(seqId)
			worker.postMessage({ type: 'cancel', seqId } satisfies WorkerTypes.ToWorker)
		}
	})
	if (type === 'init') return request$
	return Rx.defer(() => ensureFullSetup()).pipe(Rx.switchMap(() => request$))
}

async function sendWorkerRequest<T extends RequestType>(type: T, input: RequestInput<T>, signal?: AbortSignal) {
	return await Rx.Ext.firstValueFrom(workerRequest$(type, input), signal)
}

function onWorkerMessage(event: MessageEvent<WorkerTypes.FromWorker>) {
	const message = event.data
	if (message.type === 'worker-log') {
		LOGS.showLogEvent(message.payload)
		return
	}
	if (message.type === 'layer-download-started') {
		const store = Store.getState()
		if (store.status === 'initializing') store.setStatus('downloading-layers')
		return
	}
	responseHandlers.get(message.seqId)?.(message)
}

let setup$: Promise<void> | null = null
export async function ensureFullSetup() {
	if (setup$) return await setup$
	try {
		Store.getState().setStatus('initializing')
		setup$ = setup()
		await setup$
		Store.getState().setStatus('ready')
	} catch (error) {
		console.error('Error setting up layer queries:', error)
		const errorMessage = error instanceof Error ? error.message : String(error)
		Store.getState().setStatus('error', errorMessage)
		throw error
	}
}

async function setup() {
	if (typeof SharedWorker !== 'undefined') {
		const sharedWorker = new LQSharedWorker({ name: 'layer-queries-worker' })
		// addEventListener does not start the port on its own
		sharedWorker.port.start()
		worker = sharedWorker.port
		// a page kept in the back/forward cache can come back, and still needs its port
		window.addEventListener('pagehide', (event) => {
			if (!event.persisted) sharedWorker.port.postMessage({ type: 'disconnect' } satisfies WorkerTypes.ToWorker)
		})
	} else {
		worker = new LQWorker({ name: 'layer-queries-worker' })
	}

	// listening before any await so a download already in flight in the shared worker still surfaces its status
	worker.addEventListener('message', onWorkerMessage as (event: Event) => void)

	const [config, filters, layerData] = await Promise.all([
		ConfigClient.fetchConfig(),
		Rx.firstValueFrom(FilterEntityClient.initializedFilterEntities$()),
		LayerDataClient.setup(),
	])

	const input: WorkerTypes.InitRequest['input'] = {
		...CS.init(),
		generationConfig: config.layerGeneration,
		filters,
		layerData: null,
		layerDataHash: LayerDataClient.hash,
		serverLayerDataHash: config.layerDataHash,
		cacheLayerArtifact: config.cacheLayerArtifact,
	}
	const initPromise = (async () => {
		const result = await sendWorkerRequest('init', input)
		if (result.code !== 'need-layer-data') return result
		// another tab may already have handed a shared worker this layer data, so it is only cloned over on request
		return await sendWorkerRequest('init', {
			...input,
			layerData: { components: layerData.components, extraColumns: layerData.extraColumns },
		})
	})()

	// both requests wait on ensureFullSetup, so they reach the worker only after init
	FilterEntityClient.filterEntities$.pipe(Rx.observeOn(Rx.asyncScheduler)).subscribe((filters) => {
		void sendWorkerRequest('filter-update', filters)
		Store.getState().incrementBackgroundStateEpoch()
	})

	// generation weights are a global setting: the config stream re-pushes on every settings change, so refresh the
	// worker's copy instead of leaving it frozen at whatever was configured when the page loaded. the stream replays
	// the config the worker was just initialized with, so skip that one and only forward actual changes
	ConfigClient.config$
		.pipe(
			Rx.map((config) => config.layerGeneration),
			Rx.distinctUntilChanged(Obj.deepEqual),
			Rx.skip(1),
			Rx.observeOn(Rx.asyncScheduler),
		)
		.subscribe((generation) => {
			void sendWorkerRequest('generation-update', generation)
			Store.getState().incrementBackgroundStateEpoch()
		})

	const result = await initPromise
	if (result.code === 'err:stale-layer-data') {
		RPC.reloadForSkew('The layer data this page loaded is not what the server serves', RPC_Msgs.layerPoolUpdated())
		// the page is on its way out: settling would run queries against layer data the worker does not hold
		return await new Promise<never>(() => {})
	}
	if (result.code === 'need-layer-data') throw new Error('the layer query worker asked again for the layer data it was sent')
}

export function getLayerInfoQueryOptions(layer: L.LayerId | L.KnownLayer) {
	const input = { layerId: typeof layer === 'string' ? layer : layer.id }
	return RPC.orpc.layerQueries.getLayerInfo.queryOptions({ input, staleTime: Infinity })
}

export function fetchLayerInfo(layer: L.LayerId | L.KnownLayer) {
	return RPC.queryClient.getQueryCache().build(RPC.queryClient, getLayerInfoQueryOptions(layer)).fetch()
}
