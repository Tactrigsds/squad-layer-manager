import type * as SquadServerFrame from '@/frames/squad-server.frame'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import { buildUseOpenWindow } from '@/systems/draggable-window.client'

export type SwitchRequestsWindowProps = { stores: SquadServerFrame.KeyProp }

export const useOpenSwitchRequestsWindow = buildUseOpenWindow<SwitchRequestsWindowProps>(WINDOW_ID.enum['switch-requests'])
