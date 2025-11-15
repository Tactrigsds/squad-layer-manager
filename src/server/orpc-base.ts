import { os } from '@orpc/server'
import type * as C from './context.ts'

const base = os.$context<C.OrpcBase>()

export default base
