import { WINDOW_ID } from '@/models/draggable-windows.models'
import { buildUseOpenWindow } from '@/systems/draggable-window.client'

export type SandboxPanelWindowProps = { serverId: string }

export const useOpenSandboxAdminListWindow = buildUseOpenWindow<SandboxPanelWindowProps>(WINDOW_ID.enum['sandbox-admin-list'])
export const useOpenSandboxConsoleWindow = buildUseOpenWindow<SandboxPanelWindowProps>(WINDOW_ID.enum['sandbox-console'])
