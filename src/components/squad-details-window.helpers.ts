import { WINDOW_ID } from '@/models/draggable-windows.models'
import { buildUseOpenWindow } from '@/systems/draggable-window.client'

export type SquadDetailsWindowProps = {
	uniqueSquadId: number
}

export const useOpenSquadDetailsWindow = buildUseOpenWindow<SquadDetailsWindowProps>(WINDOW_ID.enum['squad-details'])
