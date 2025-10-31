import * as Zus from 'zustand'

export type State = object

export const FrameStore = Zus.createStore<State>(() => ({}))
