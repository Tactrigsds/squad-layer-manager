import * as FRM from '@/lib/frame'
import * as ZusUtils from '@/lib/zustand'

export const frameManager = new FRM.FrameManager()

// lets ZusUtils.useStore & co accept frame instance keys as inputs
ZusUtils.registerFrameKeyResolver((key) => frameManager.getInstance(key))

export const { useFrameLifecycle } = FRM.createFrameHelpers(
	frameManager,
)
