import * as FRM from '@/lib/frame'
import * as Zus from '@/lib/zustand'

export const frameManager = new FRM.FrameManager()

// lets Zus.useStore & co accept frame instance keys as inputs
Zus.registerFrameKeyResolver((key) => frameManager.getInstance(key))

export const { useFrameLifecycle, useFrameTeardownOnUnmount } = FRM.createFrameHelpers(frameManager)
