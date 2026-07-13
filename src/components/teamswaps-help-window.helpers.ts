import { WINDOW_ID } from '@/models/draggable-windows.models'
import { buildUseOpenWindow } from '@/systems/draggable-window.client'

export type TeamswapsHelpWindowProps = Record<string, never>

export const useOpenTeamswapsHelpWindow = buildUseOpenWindow<TeamswapsHelpWindowProps>(WINDOW_ID.enum['teamswaps-help'])
