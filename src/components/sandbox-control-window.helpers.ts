import { WINDOW_ID } from '@/models/draggable-windows.models'
import { buildUseOpenWindow } from '@/systems/draggable-window.client'

export type SandboxControlWindowProps = { serverId: string }

export const useOpenSandboxControlWindow = buildUseOpenWindow<SandboxControlWindowProps>(WINDOW_ID.enum['sandbox-control'])
