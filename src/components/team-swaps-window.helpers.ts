import type * as SquadServerFrame from '@/frames/squad-server.frame'
import { WINDOW_ID } from '@/models/draggable-windows.models'
import { buildUseOpenWindow } from '@/systems/draggable-window.client'

export type TeamSwapsWindowProps = { stores: SquadServerFrame.KeyProp }

export const useOpenTeamSwapsWindow = buildUseOpenWindow<TeamSwapsWindowProps>(WINDOW_ID.enum['team-swaps'])
