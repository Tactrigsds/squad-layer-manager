import path from 'path'

export const PROJECT_ROOT = process.cwd()
export const ASSETS = path.join(PROJECT_ROOT, 'assets')
// the layer artifacts that ship with the app (see systems/layer-artifacts.server.ts)
export const LAYERS = path.join(ASSETS, 'layers')
export const DATA = path.join(PROJECT_ROOT, 'data')
export const DIST = path.join(PROJECT_ROOT, 'dist')
// released changelog fragments, one folder per release, plus releases.json (see models/changelog.models.ts)
export const CHANGELOG = path.join(PROJECT_ROOT, 'changelog')
// fragments merged since the last release
export const CHANGES = path.join(PROJECT_ROOT, 'changes')
