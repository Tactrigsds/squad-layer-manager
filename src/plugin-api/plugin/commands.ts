/**
 * Contributing in-game commands. The host owns trigger matching, the chat and enabled gates and the permission
 * check, so a handler only ever runs for a caller who was allowed to run it. Triggers and chats are configurable
 * under `pluginCommands` in global settings; what a plugin declares is the default.
 */
export { registerCommand as register } from '@/systems/plugins.server'
export type { PluginCommandHandler, PluginCommandInput } from '@/systems/plugins.server'
export type { ChatGroup, PluginCommandDeclaration } from '@/models/command.models'
