import { WINDOW_ID } from '@/models/draggable-windows.models'
import { buildUseOpenWindow } from '@/systems/draggable-window.client'

export type PlayerDetailsWindowProps = {
	playerId: string
}

export const useOpenPlayerDetailsWindow = buildUseOpenWindow<PlayerDetailsWindowProps>(WINDOW_ID.enum['player-details'])
