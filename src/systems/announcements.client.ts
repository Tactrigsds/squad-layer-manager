import * as Zus from '@/lib/zustand'
import * as RPC from '@/orpc.client'
import type { Announcement } from '@/systems/announcements.server'

type State = { announcement: Announcement | null; dismissedId: string | null }

export const Store = Zus.createStore<State>(() => ({ announcement: null, dismissedId: null }))

export const Sel = {
	visible: (s: State) => (s.announcement && s.announcement.id !== s.dismissedId ? s.announcement : null),
}

export namespace Actions {
	export function dismiss() {
		Store.setState((s) => ({ dismissedId: s.announcement?.id ?? null }))
	}
}

export function setup() {
	RPC.observe('announcements.watch', () => RPC.orpc.announcements.watch.call()).subscribe((announcement) => {
		Store.setState({ announcement })
	})
}
