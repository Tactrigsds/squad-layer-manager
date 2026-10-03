import type * as SquadServerFrame from '@/frames/squad-server.frame'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import type { ChartsTab } from '@/systems/client-only-settings.client'
import { buildUseOpenWindow } from '@/systems/draggable-window.client'

export type ChartWindowProps = { stores: SquadServerFrame.KeyProp; tab: ChartsTab }

export const useOpenChartWindow = buildUseOpenWindow<ChartWindowProps>(WINDOW_ID.enum.chart)
