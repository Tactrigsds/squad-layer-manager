import { WINDOW_ID } from '@/models/draggable-windows.models'
import { buildUseOpenWindow } from '@/systems/draggable-window.client'

export type SwitchRequestsWindowProps = { serverId: string }

export const useOpenSwitchRequestsWindow = buildUseOpenWindow<SwitchRequestsWindowProps>(WINDOW_ID.enum['switch-requests'])
