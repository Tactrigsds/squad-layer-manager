// import * as Zus from 'zustand'
// import * as M from '@/models'
// import { initMutations, ItemMutations, WithMutationId } from './lib/item-mutations'
// import React from 'react'
// import { Parts } from './lib/types'
// import { UseSubscriptionOptions } from 'react-query-subscription'
// import { createId } from './lib/id'
// import { produce } from 'immer'

// type IdedLayerQueueItem = M.LayerQueueItem & WithMutationId
// type EditedHistoryFilterWithId = M.HistoryFilterEdited & WithMutationId
// type MutServerStateWithIds = M.MutableServerState & {
// 	layerQueue: IdedLayerQueueItem[]
// 	historyFilters: EditedHistoryFilterWithId[]
// }

// type SDStoreState = {
// 	serverStateMut: MutServerStateWithIds | null
// 	queueMutations: ItemMutations
// 	historyFiltersMutations: ItemMutations
// }

// type SDStoreActions = {
//   setServerStateMut: React.Dispatch<React.SetStateAction<MutServerStateWithIds | null>>
// }
// type SDStore = SDStoreState & SDStoreActions
// const initialState: SDStore = {
// 	serverStateMut: null,
// 	queueMutations: initMutations(),
// 	historyFiltersMutations: initMutations(),
// }

// type LQStoreState = {
// 	queue: M.LayerQueue
// 	mutations: ItemMutations
// 	queueLength: number
// }

// type LQStoreActions =  {
// 	addToQueue: (item: M.LayerQueueItem) => void
// }
// type LQStore = LQStoreState & LQStoreActions
// type PStore<T> = () => T

// const SDStore = Zus.create<SDStore>((set, get) => ({
//   serverStateMut: null,
// 	queueMutations: initMutations(),
// 	historyFiltersMutations: initMutations(),
//   setServerStateMut: update => typeof update === 'function' ? set({ serverStateMut: update(get().serverStateMut) }) : set({ serverStateMut: update }),
// }))

// function LayerQueue(props: {store:  PStore<LQStore>}) {
// }

// const lqStoreActions = {
//   addToQueue: (item: M.LayerQueueItem) => {
//     SDStore.getState().setServerStateMut(produce(draft => {
//       if (!draft) return
//       draft.layerQueue.push({ ...item, id: createId(6) })
//     }))
//   },
// }

// export default function ZustandTest() {
// 	const state = SDStore((state) => state)

// 	React.useEffect(() => {
// 	}, [SDStore])

// 	return (
// 		<div
// 			onClick={() => {
// 				state.addToQueue({ layerId: '69', source: 'gameserver' })
// 			}}
// 		>
// 			{JSON.stringify(state.queueLength)}
// 		</div>
// 	)
// }
