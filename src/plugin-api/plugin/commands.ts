/**
 * Contributing in-game commands. The host owns trigger matching and the chat and enabled gates. Triggers and
 * chats are configurable under `pluginCommands` in global settings; what a plugin declares is the default.
 *
 * Authorization is not among the gates. What a command requires can depend on the arguments it was given, so
 * the handler checks it, against `input.player`, through slm/systems/rbac. A command that only reads may need
 * nothing; one that acts on the server needs to say so itself.
 */
export { registerCommand as register } from '@/systems/plugins.server'
export type { PluginCommandHandler, PluginCommandInput } from '@/systems/plugins.server'
export type { ChatGroup, PluginCommandDeclaration } from '@/models/command.models'
