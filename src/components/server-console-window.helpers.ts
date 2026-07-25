import { WINDOW_ID } from '@/models/draggable-windows.models'
import { buildUseOpenWindow } from '@/systems/draggable-window.client'

export type ServerConsoleWindowProps = { serverId: string }

export const useOpenServerConsoleWindow = buildUseOpenWindow<ServerConsoleWindowProps>(WINDOW_ID.enum['server-console'])
