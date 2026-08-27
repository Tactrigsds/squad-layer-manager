/**
 * Queue reads and edits. dispatchOp is the same op path the web client goes through, so a plugin's
 * edits are ordinary edits. Lifecycle, sync and the router stay with the host.
 */
export { dispatchOp, editSaved, getSavedBackburner, getSavedQueue, getSlmUpdatesEnabled } from '@/systems/layer-queue.server'
export type { QueueEntry } from '@/systems/layer-queue.server'
