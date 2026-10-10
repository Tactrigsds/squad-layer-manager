import { useQuery } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React from 'react'

import ComboBoxMulti from '@/components/combo-box/combo-box-multi'
import { HelpTip } from '@/components/settings-form/controls'
import { type OverrideProps, scopeValue, useFieldValue } from '@/components/settings-form/settings-form.helpers'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import * as SM_Msgs from '@/messages/squad.messages'
import * as SM from '@/models/squad.models'
import * as RPC from '@/orpc.client'
import { tr } from '@/systems/messages.client'

const PLAYER_PERM_OPTIONS = SM.PLAYER_PERM.options.map((perm) => ({ value: perm }))

const ADMIN_SOURCE_TYPES = ['remote', 'local', 'ftp', 'sftp'] as const satisfies readonly SM.AdminListSourceType[]

function defaultAdminSource(type: SM.AdminListSourceType): SM.AdminListSource {
	if (type === 'sftp') return { type: 'sftp', host: '', port: 22, username: '', password: '', filePath: '' }
	return { type, source: '' }
}

// Which of the defined lists apply to this server. A sandbox additionally has one SLM synthesises, which is not
// listed here because there is no source to name -- so say so, rather than leaving the impression that an empty
// selection means the emulated server has no admins.
export function ServerAdminListsField({ value$, onChange, root }: OverrideProps) {
	const value = (useFieldValue(value$) as string[] | undefined) ?? []
	const connType$ = scopeValue(scopeValue(root.value$, 'connections'), 'type')
	const isSandbox = useFieldValue(connType$) === 'sandbox'
	const definedLists = useQuery(RPC.orpc.rbac.listAdminListGroups.queryOptions({ staleTime: 60_000 }))
	const available = definedLists.data?.code === 'ok' ? definedLists.data.lists.map((l) => l.listId) : []
	const options = [...new Set([...available, ...value])].sort().map((listId) => ({
		value: listId,
		label: available.includes(listId) ? listId : tr.text(SM_Msgs.adminListNotConfigured(listId)),
	}))

	return (
		<div className="space-y-2">
			<div className="max-w-[28rem]">
				<ComboBoxMulti
					title={tr.text(SM_Msgs.adminListPicker())}
					values={value}
					options={options}
					emptyLabel={tr.text(SM_Msgs.selectAdminLists())}
					chipDisplay
					onSelect={(next) => onChange(typeof next === 'function' ? next(value) : next)}
				/>
			</div>
			{isSandbox && (
				<Alert>
					<Icons.Info className="h-4 w-4" />
					<AlertTitle>{tr.text(SM_Msgs.sandboxAdminListTitle())}</AlertTitle>
					<AlertDescription>{tr.text(SM_Msgs.sandboxAdminListBlurb())}</AlertDescription>
				</Alert>
			)}
		</div>
	)
}

// Editor for the named admin lists (global settings). Each is a name, one source (remote/local/ftp/sftp) and the
// group permissions that mark an admin *in that list*. The name is what servers and role assignments refer to, so
// renaming one is a breaking edit -- hence the rename is explicit rather than an inline text field that fires per
// keystroke.
export function AdminListsField({ value$, reset$, onChange }: OverrideProps) {
	const value = (useFieldValue(value$) as Record<string, SM.AdminListDef> | undefined) ?? {}
	const names = Object.keys(value)
	const [newName, setNewName] = React.useState('')

	const update = (fn: (v: Record<string, SM.AdminListDef>) => Record<string, SM.AdminListDef>, quiet?: boolean) => {
		onChange(fn((value$.getValue() as Record<string, SM.AdminListDef> | undefined) ?? {}))
		if (!quiet) reset$.next()
	}

	const patchSource = (name: string, p: Partial<SM.AdminListSource>, quiet?: boolean) =>
		update((v) => ({ ...v, [name]: { ...v[name], source: { ...v[name].source, ...p } as SM.AdminListSource } }), quiet)

	const canAdd = /^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(newName) && !(newName in value)
	function addList() {
		if (!canAdd) return
		update((v) => ({ ...v, [newName]: { source: defaultAdminSource('local'), adminIdentifyingPermissions: [] } }))
		setNewName('')
	}

	return (
		<div className="space-y-3">
			{names.length === 0 && <p className="text-xs text-muted-foreground">{tr.text(SM_Msgs.noAdminLists())}</p>}
			{names.map((name) => {
				const def = value[name]
				const source = def.source
				return (
					<div key={name} className="space-y-2 rounded-md border p-3">
						<div className="flex items-center gap-2">
							<code className="font-mono text-sm font-semibold">{name}</code>
							<Select
								value={source.type}
								onValueChange={(t) =>
									update((v) => ({
										...v,
										[name]: { ...v[name], source: defaultAdminSource(t as SM.AdminListSourceType) },
									}))
								}
							>
								<SelectTrigger className="h-8 w-[9rem]">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{ADMIN_SOURCE_TYPES.map((type) => (
										<SelectItem key={type} value={type}>
											{tr.text(SM_Msgs.adminSourceTypeLabels[type])}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<Button
								type="button"
								size="icon"
								variant="ghost"
								className="ms-auto h-7 w-7 text-destructive"
								title={tr.text(SM_Msgs.deleteAdminList(name))}
								onClick={() =>
									update((v) => {
										const next = { ...v }
										delete next[name]
										return next
									})
								}
							>
								<Icons.Trash2 className="h-4 w-4" />
							</Button>
						</div>

						{source.type === 'sftp' ? (
							<div className="grid grid-cols-2 gap-2">
								<Input
									className="h-8"
									placeholder={tr.text(SM_Msgs.sftpHost())}
									defaultValue={source.host}
									onChange={(e) => patchSource(name, { host: e.target.value }, true)}
								/>
								<Input
									className="h-8"
									type="number"
									placeholder="22"
									defaultValue={source.port}
									onChange={(e) => patchSource(name, { port: Number(e.target.value) }, true)}
								/>
								<Input
									className="h-8"
									placeholder={tr.text(SM_Msgs.sftpUsername())}
									defaultValue={source.username}
									onChange={(e) => patchSource(name, { username: e.target.value }, true)}
								/>
								<Input
									className="h-8"
									type="password"
									placeholder={tr.text(SM_Msgs.sftpPassword())}
									defaultValue={source.password}
									onChange={(e) => patchSource(name, { password: e.target.value }, true)}
								/>
								<Input
									className="col-span-2 h-8"
									placeholder={tr.text(SM_Msgs.sftpFilePath())}
									defaultValue={source.filePath}
									onChange={(e) => patchSource(name, { filePath: e.target.value }, true)}
								/>
							</div>
						) : (
							<Input
								className="h-8"
								placeholder={SM_Msgs.adminSourcePlaceholders[source.type]}
								defaultValue={source.source}
								onChange={(e) => patchSource(name, { source: e.target.value }, true)}
							/>
						)}

						<div className="space-y-1">
							<label className="flex items-center gap-1 text-xs text-muted-foreground">
								{tr.text(SM_Msgs.adminIdentifyingPermissions())}
								<HelpTip text={tr.text(SM_Msgs.adminIdentifyingPermissionsHelp())} />
							</label>
							<ComboBoxMulti
								title={tr.text(SM_Msgs.permissionPicker())}
								values={def.adminIdentifyingPermissions}
								options={PLAYER_PERM_OPTIONS}
								emptyLabel={tr.text(SM_Msgs.selectPermissions())}
								chipDisplay
								onSelect={(next) =>
									update((v) => ({
										...v,
										[name]: {
											...v[name],
											adminIdentifyingPermissions: (typeof next === 'function'
												? next(v[name].adminIdentifyingPermissions)
												: next) as SM.PlayerPerm[],
										},
									}))
								}
							/>
						</div>
					</div>
				)
			})}
			<div className="flex items-center gap-1.5">
				<Input
					className="h-8 w-[14rem]"
					placeholder={tr.text(SM_Msgs.newAdminListName())}
					value={newName}
					onChange={(e) => setNewName(e.target.value)}
					onKeyDown={(e) => {
						if (e.key !== 'Enter') return
						e.preventDefault()
						addList()
					}}
				/>
				<Button type="button" size="sm" variant="outline" className="h-8" disabled={!canAdd} onClick={addList}>
					<Icons.Plus className="me-1 h-4 w-4" />
					{tr.text(SM_Msgs.addAdminList())}
				</Button>
			</div>
		</div>
	)
}
