/**
 * The client half of a plugin's own rpc. Both are built from the server router's *type*:
 *
 * ```ts
 * import type { router } from './server.ts'
 * const rpc = Rpc.client<typeof router>(ctx, serverId)
 * const streams = Rpc.stores<typeof router>(ctx)
 * ```
 *
 * `import type` is erased, so naming the server module here puts none of it in the browser bundle.
 */
export { client, stores } from '@/systems/plugins.client'
export type { Stores } from '@/systems/plugins.client'
