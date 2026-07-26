import * as FRM from '@/lib/frame'
import * as Zus from '@/lib/zustand'
import * as CS from '@/models/context-shared'
import { baseLogger } from '@/systems/logger.client'

export const frameManager = new FRM.FrameManager({ ...CS.init(), log: baseLogger.child({ name: 'frames' }) })

// lets Zus.useStore & co accept frame instance keys as inputs
Zus.registerFrameKeyResolver((key) => frameManager.getInstance(key))

export const { useFrameLifecycle, useFrameTeardownOnUnmount } = FRM.createFrameHelpers(frameManager)
