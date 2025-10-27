import path from 'path'

const currentDir = path.dirname(new URL(import.meta.url).pathname)
// if we're in the prod esbuild context then we're not in the project directory
export const PROJECT_ROOT = currentDir.includes('dist-server') ? path.dirname(currentDir) : currentDir
export const ASSETS = path.join(PROJECT_ROOT, 'assets')
export const DATA = path.join(PROJECT_ROOT, 'data')
export const DIST = path.join(PROJECT_ROOT, 'dist')
