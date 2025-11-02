import * as FRM from '@/lib/frame'

export const frameManager = new FRM.FrameManager()

export const { useFrameLifecycle, useFrameStore, getFrameState, getFrameReaderStore } = FRM.createFrameHelpers(frameManager)
