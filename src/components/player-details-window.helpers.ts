import type * as SquadServerFrame from '@/frames/squad-server.frame'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import { buildUseOpenWindow } from '@/systems/draggable-window.client'

export type PlayerDetailsWindowProps = {
	playerId: string
	// captured at open-time; if the user switches servers while the window is open, it keeps showing data
	// for the server it was opened from rather than following the switch. Absent when opened from somewhere
	// with no live server behind it (the history page), which renders the frameless variant.
	stores?: SquadServerFrame.KeyProp
}

export const useOpenPlayerDetailsWindow = buildUseOpenWindow<PlayerDetailsWindowProps>(WINDOW_ID.enum['player-details'])
