import type * as SquadServerFrame from '@/frames/squad-server.frame'
import * as Zus from '@/lib/zustand'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import type { ChartsTab } from '@/systems/client-only-settings.client'
import { DraggableWindowStore, useOutletKey } from '@/systems/draggable-window.client'

// `size` is the chart's size in the panel it was popped out of, which the window opens at
export type ChartWindowProps = { stores: SquadServerFrame.KeyProp; tab: ChartsTab; size?: { width: number; height: number } }

// one window per chart per server
export function chartWindowId(serverId: string, tab: ChartsTab) {
	return `chart:${serverId}:${tab}`
}

// whether the chart is open in its window, where the panel stands a placeholder in for it
export function useChartPoppedOut(serverId: string, tab: ChartsTab) {
	const id = chartWindowId(serverId, tab)
	return Zus.useStore(DraggableWindowStore, (s) => s.windows.some((w) => w.id === id))
}

export function closeChartWindow(serverId: string, tab: ChartsTab) {
	DraggableWindowStore.getState().closeWindow(chartWindowId(serverId, tab))
}

// takes the props when the window opens rather than when the hook runs, so the size can be measured on the click
export function useOpenChartWindow() {
	const outletKey = useOutletKey()
	return (props: ChartWindowProps, anchor?: HTMLElement | null) =>
		DraggableWindowStore.getState().openWindow(WINDOW_ID.enum.chart, props, anchor, outletKey)
}
