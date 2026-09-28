/**
 * Contributing in-game commands. The host owns trigger matching and the chat, enabled and access gates. Admins
 * configure triggers and chats per command on the plugin's own settings; what a plugin declares is the default.
 *
 * `access` says what the caller needs on the server the command is typed on, and the host checks it before the
 * handler runs. Where the arguments decide what is needed, declare what is needed regardless with
 * `Access.inHandler(why, before)` and check the rest in the handler, through slm/systems/rbac:
 *
 * ```ts
 * Commands.register(ctx, {
 *   name: 'roll',
 *   ...
 *   access: RBAC.Access.req(({ serverId }) => Perms.roll(serverId)),
 *   handler: async (sctx, input) => roll(sctx),
 * })
 * ```
 */
export { registerCommand as register } from '@/systems/plugins.server'
export type { PluginCommandHandler, PluginCommandInput } from '@/systems/plugins.server'
export type { ChatGroup, PluginCommandDeclaration } from '@/models/command.models'
