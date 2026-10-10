import { useQuery } from '@tanstack/react-query'
import * as Icons from 'lucide-react'

import ComboBoxMulti from '@/components/combo-box/combo-box-multi'
import { DiscordMemberSelect, DiscordRoleSelect } from '@/components/discord-picker'
import { HelpTip } from '@/components/settings-form/controls'
import {
	decodeListGroup,
	encodeListGroup,
	type RbacUpdate,
	type RoleConfig,
	withAssignments,
	withRoleConfig,
} from '@/components/settings-form/editors/rbac.helpers'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import * as RBAC_Msgs from '@/messages/rbac.messages'
import * as SM_Msgs from '@/messages/squad.messages'
import * as RPC from '@/orpc.client'
import { tr } from '@/systems/messages.client'

export function RoleAssignmentsEditor({
	roleId,
	assignments,
	update,
	assigned,
}: {
	roleId: string
	assignments: RoleConfig['assignments']
	update: RbacUpdate
	assigned: boolean
}) {
	const roleAssignIds = (assignments?.discordRoleIds ?? []).map(String)
	const userAssignIds = (assignments?.discordUserIds ?? []).map(String)

	// replace `oldId` with `nextId` in one of the assignment id lists; '' as oldId adds, '' as nextId removes
	function changeAssignment(bucket: 'discordRoleIds' | 'discordUserIds', oldId: string, nextId: string) {
		if (nextId === oldId) return
		update((r) =>
			withRoleConfig(r, roleId, (c) => {
				const cur = (c.assignments?.[bucket] ?? []).map(String).filter((id) => id !== oldId)
				if (nextId && !cur.includes(nextId)) cur.push(nextId)
				return withAssignments(c, { [bucket]: cur })
			}),
		)
	}
	const changeDiscordRole = (oldId: string, nextId: string) => changeAssignment('discordRoleIds', oldId, nextId)
	const changeDiscordUser = (oldId: string, nextId: string) => changeAssignment('discordUserIds', oldId, nextId)

	// A group only means something together with the list that defines it, so options and selections are both the pair,
	// encoded as "list/group" for the multi-select. Two lists may define the same group name and they are not the same
	// grant. Already-selected pairs are kept even when their list or group is gone, so opening the editor never
	// silently drops a grant.
	const groupsRes = useQuery(RPC.orpc.rbac.listAdminListGroups.queryOptions({ staleTime: 60_000 }))
	const availableLists = groupsRes.data?.code === 'ok' ? groupsRes.data.lists : []
	const availablePairs = availableLists.flatMap((l) => l.groups.map((g) => encodeListGroup(l.listId, g)))
	const selectedGroups = assignments?.adminListGroups ?? []
	const selectedPairs = selectedGroups.map((g) => encodeListGroup(g.listId, g.groupId))
	const groupOptions = [...new Set([...availablePairs, ...selectedPairs])].sort().map((pair) => ({
		value: pair,
		label: availablePairs.includes(pair) ? pair : tr.text(RBAC_Msgs.groupNotInAnyList(pair)),
	}))
	const availableListIds = availableLists.map((l) => l.listId)
	const selectedIngameLists = assignments?.ingameAdminLists ?? []
	const ingameListOptions = [...new Set([...availableListIds, ...selectedIngameLists])].sort().map((listId) => ({
		value: listId,
		label: availableListIds.includes(listId) ? listId : tr.text(SM_Msgs.adminListNotConfigured(listId)),
	}))
	function setGroups(next: string[]) {
		const pairs = next.map(decodeListGroup).filter((p): p is { listId: string; groupId: string } => p !== null)
		update((r) => withRoleConfig(r, roleId, (c) => withAssignments(c, { adminListGroups: pairs })))
	}
	function setIngameLists(next: string[]) {
		update((r) => withRoleConfig(r, roleId, (c) => withAssignments(c, { ingameAdminLists: next })))
	}

	return (
		<div className="space-y-3">
			{!assigned && (
				<p className="flex items-center gap-1 text-xs text-warn dark:text-warn">
					<Icons.TriangleAlert className="h-3 w-3 shrink-0" />
					{tr.text(RBAC_Msgs.roleUnassigned())}
				</p>
			)}
			<div className="flex items-center gap-2">
				<Switch
					checked={!!assignments?.everyMember}
					onCheckedChange={(on) => update((r) => withRoleConfig(r, roleId, (c) => withAssignments(c, { everyMember: on })))}
				/>
				<span className="text-sm">{tr.text(RBAC_Msgs.everyMember())}</span>
			</div>

			<div className="space-y-1.5">
				<label className="flex items-center gap-1 text-xs text-muted-foreground">
					{tr.text(RBAC_Msgs.ingameAdminsOfLists())}
					<HelpTip
						text={tr.text(RBAC_Msgs.ingameAdminsHelp())}
						links={[{ label: tr.text(RBAC_Msgs.adminListsLink()), anchor: 'setting:adminLists' }]}
					/>
				</label>
				<div className="max-w-[28rem]">
					<ComboBoxMulti
						title={tr.text(SM_Msgs.adminListPicker())}
						values={selectedIngameLists}
						options={ingameListOptions}
						emptyLabel={tr.text(SM_Msgs.selectAdminLists())}
						chipDisplay
						onSelect={(next) => setIngameLists(typeof next === 'function' ? next(selectedIngameLists) : next)}
					/>
				</div>
			</div>

			<div className="space-y-1.5">
				<label className="text-xs text-muted-foreground">{tr.text(RBAC_Msgs.discordRoles())}</label>
				{roleAssignIds.map((id) => (
					<div key={id} className="flex items-center gap-2">
						<div className="min-w-0 flex-1 max-w-[24rem]">
							<DiscordRoleSelect value={id} onChange={(next) => changeDiscordRole(id, next)} />
						</div>
						<Button
							type="button"
							size="icon"
							variant="ghost"
							className="h-8 w-8 text-destructive"
							onClick={() => changeDiscordRole(id, '')}
						>
							<Icons.X className="h-4 w-4" />
						</Button>
					</div>
				))}
				<div className="max-w-[24rem]">
					<DiscordRoleSelect value="" onChange={(next) => next && changeDiscordRole('', next)} />
				</div>
			</div>

			<div className="space-y-1.5">
				<label className="text-xs text-muted-foreground">{tr.text(RBAC_Msgs.discordUsers())}</label>
				{userAssignIds.map((id) => (
					<div key={id} className="flex items-center gap-2">
						<div className="min-w-0 flex-1 max-w-[24rem]">
							<DiscordMemberSelect value={id} onChange={(next) => changeDiscordUser(id, next)} />
						</div>
						<Button
							type="button"
							size="icon"
							variant="ghost"
							className="h-8 w-8 text-destructive"
							onClick={() => changeDiscordUser(id, '')}
						>
							<Icons.X className="h-4 w-4" />
						</Button>
					</div>
				))}
				<div className="max-w-[24rem]">
					<DiscordMemberSelect value="" onChange={(next) => next && changeDiscordUser('', next)} />
				</div>
			</div>

			<div className="space-y-1.5">
				<label className="flex items-center gap-1 text-xs text-muted-foreground">
					{tr.text(RBAC_Msgs.adminListGroups())}
					<HelpTip
						text={tr.text(RBAC_Msgs.adminListGroupsHelp())}
						links={[{ label: tr.text(RBAC_Msgs.adminListsLink()), anchor: 'setting:adminLists' }]}
					/>
				</label>
				{groupOptions.length === 0 ? (
					<p className="text-xs text-muted-foreground">{tr.text(RBAC_Msgs.noAdminListGroups())}</p>
				) : (
					<div className="max-w-[28rem]">
						<ComboBoxMulti
							title={tr.text(RBAC_Msgs.groupPicker())}
							values={selectedPairs}
							options={groupOptions}
							emptyLabel={tr.text(RBAC_Msgs.selectAdminListGroups())}
							chipDisplay
							onSelect={(next) => setGroups(typeof next === 'function' ? next(selectedPairs) : next)}
						/>
					</div>
				)}
			</div>
		</div>
	)
}
