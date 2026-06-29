import { WINDOW_ID } from '@/models/draggable-windows.models'
import { buildUseOpenWindow } from '@/systems/draggable-window.client'

export type TeamswitchesHelpWindowProps = Record<string, never>

export const useOpenTeamswitchesHelpWindow = buildUseOpenWindow<TeamswitchesHelpWindowProps>(WINDOW_ID.enum['teamswitches-help'])
