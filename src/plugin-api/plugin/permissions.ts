/**
 * Actions this plugin defines for itself, so an admin can grant them to a role.
 *
 * ```ts
 * const Perms = Permissions.register(ctx, {
 *   roll: { scope: 'server', description: 'Roll the server to a seeding layer' },
 * })
 * // later, in a command or rpc handler
 * const denial = await Rbac.checkPlayer(ctx, input.player, Perms.roll(ctx.serverId))
 * ```
 *
 * Reuse a core permission where one fits (`squad-server:end-match` for anything deciding what plays next,
 * `queue:write` for queue edits): admins already grant those, and a new action asks every install to configure
 * something. Declare one where the plugin does something SLM has no analogue for.
 *
 * A grant names the plugin and the action as plain strings, so it survives the plugin being stopped or
 * uninstalled. Nothing is granted for an action no running plugin declares.
 */
export { registerPermissions as register } from '@/systems/plugins.server'
export type { PermissionBuilders, PermissionDeclaration } from '@/models/plugins.models'
