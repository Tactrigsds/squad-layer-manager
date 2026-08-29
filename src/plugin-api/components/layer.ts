/**
 * A layer's name as the app renders it: broken into parts, team colours applied, and clickable through to
 * the layer-info dialog.
 *
 * Deliberately narrower than the host's own component. The extra props it takes (team parity, backfill,
 * match descriptors, drop-target refs) belong to the queue and the match history, and exposing them would
 * pin all of them as contract.
 */
export { LayerName } from '@/components/layer-name'
