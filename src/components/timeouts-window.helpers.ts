import { WINDOW_ID } from '@/models/draggable-windows.models'
import { buildUseOpenWindow } from '@/systems/draggable-window.client'

// timeouts are global (enforced on every SLM-managed server), so the window takes no per-server props
export type TimeoutsWindowProps = Record<string, never>

export const useOpenTimeoutsWindow = buildUseOpenWindow<TimeoutsWindowProps>(WINDOW_ID.enum['timeouts'])
