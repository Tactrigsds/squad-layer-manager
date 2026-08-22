// the plugin's current config, decoded via its manifest schema. Reads always see the latest saved
// config, so read at use rather than snapshotting at activation.
export { getConfig as get } from '@/systems/plugins.server'
