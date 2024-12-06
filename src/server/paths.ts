import path from 'path'

export const PROJECT_ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..')
export const ASSETS = path.join(PROJECT_ROOT, 'assets')
export const DATA = path.join(PROJECT_ROOT, 'data')
