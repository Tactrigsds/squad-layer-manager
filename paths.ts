import path from 'path'

export const PROJECT_ROOT = process.cwd()
export const ASSETS = path.join(PROJECT_ROOT, 'assets')
// the layer artifacts that ship with the app (see systems/layer-artifacts.server.ts)
export const LAYERS = path.join(ASSETS, 'layers')
export const DATA = path.join(PROJECT_ROOT, 'data')
export const DIST = path.join(PROJECT_ROOT, 'dist')
