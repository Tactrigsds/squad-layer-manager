import type * as SquadServerFrame from '@/frames/squad-server.frame'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import { buildUseOpenWindow } from '@/systems/draggable-window.client'

export type SquadDetailsWindowProps = {
	uniqueSquadId: number
	stores: SquadServerFrame.KeyProp
}

export const useOpenSquadDetailsWindow = buildUseOpenWindow<SquadDetailsWindowProps>(WINDOW_ID.enum['squad-details'])
