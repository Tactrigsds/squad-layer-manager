import type * as SquadServerFrame from '@/frames/squad-server.frame'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import { useOpenOrFocusWindow } from '@/systems/draggable-window.client'

export type PoolConfigWindowProps = {
	stores: SquadServerFrame.KeyProp
}

export function useOpenPoolConfigWindow(props: PoolConfigWindowProps) {
	const openOrFocus = useOpenOrFocusWindow()
	return (anchor?: HTMLElement | null) => openOrFocus(WINDOW_ID.enum['pool-config'], props, anchor)
}
