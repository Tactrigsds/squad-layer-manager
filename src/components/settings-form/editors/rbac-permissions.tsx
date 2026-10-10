import * as Icons from 'lucide-react'
import React from 'react'

import ComboBox, { type ComboBoxOption } from '@/components/combo-box/combo-box'
import { ListEditor } from '@/components/list-editor.tsx'
import { serverOptionsFor } from '@/components/server-select.helpers.ts'
import { HelpTip, TextInputField } from '@/components/settings-form/controls'
import {
	globalGrantPathOptions,
	type RbacUpdate,
	type RoleConfig,
	serverGrantPathOptions,
	withRoleConfig,
} from '@/components/settings-form/editors/rbac.helpers'
import type { ValueState } from '@/components/settings-form/settings-form.helpers'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import * as Obj from '@/lib/object-utils'
import type * as Rx from '@/lib/rxjs'
import { assertNever } from '@/lib/type-guards'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as RBAC_Msgs from '@/messages/rbac.messages'
import * as PermRows from '@/models/rbac-perm-rows.models'
import { tr } from '@/systems/messages.client'
import * as SettingsClient from '@/systems/settings.client'

// one row = one permission the role holds. The five persisted fields are projected to rows on read and distributed back
// on write by PermRows, so this component only ever deals in rows.
export function RolePermissionsTable({
	roleId,
	permissions,
	globalSettingsGrants,
	serverGrants,
	serverSettingsGrants,
	maxTimeout,
	maxLayerRequests,
	timeout$,
	layerRequests$,
	reset$,
	update,
}: Pick<
	RoleConfig,
	'permissions' | 'globalSettingsGrants' | 'serverGrants' | 'serverSettingsGrants' | 'maxTimeout' | 'maxLayerRequests'
> & {
	roleId: string
	timeout$: ValueState
	layerRequests$: ValueState
	reset$: Rx.Subject<void>
	update: RbacUpdate
}) {
	const rows = PermRows.rowsFromConfig({
		permissions,
		globalSettingsGrants,
		serverGrants,
		serverSettingsGrants,
		maxTimeout,
		maxLayerRequests,
	})

	function setRows(next: PermRows.PermRow[]) {
		update((r) => withRoleConfig(r, roleId, (c) => PermRows.configFromRows(c, next)))
	}

	const wildcarded = rows.some((r) => r.type === PermRows.ALL_PERMISSIONS && r.effect === 'allow')

	// a second row of the same permission only means something when it can carry different scope args; the rest would
	// just collapse on save, so offering them is a lie
	const addOptions: ComboBoxOption<string>[] = PermRows.ADDABLE_TYPES.map((type) => {
		const repeatable = PermRows.rowScope(type) === 'server-settings' || PermRows.rowScope(type) === 'server-settings-write'
		const taken = !repeatable && rows.some((r) => r.type === type && r.effect === 'allow')
		const description = PermRows.permDescription(type)
		return { value: type, description: description && tr.text(description), disabled: taken }
	})

	return (
		<div className="space-y-2">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead className="w-[7.5rem]">{tr.text(RBAC_Msgs.effectColumn())}</TableHead>
						<TableHead className="w-[16rem]">{tr.text(RBAC_Msgs.permissionColumn())}</TableHead>
						<TableHead>{tr.text(RBAC_Msgs.scopeColumn())}</TableHead>
						<TableHead className="w-10" />
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.length === 0 && (
						<TableRow>
							<TableCell colSpan={4} className="text-xs text-muted-foreground">
								{tr.text(RBAC_Msgs.noPermissions())}
							</TableCell>
						</TableRow>
					)}
					{rows.map((row) => (
						<PermRowView
							key={row.id}
							roleId={roleId}
							row={row}
							// `*` already grants every permission, so the allow rows under it are redundant. Deny still wins over it.
							subsumed={wildcarded && row.effect === 'allow' && row.type !== PermRows.ALL_PERMISSIONS}
							timeout$={timeout$}
							layerRequests$={layerRequests$}
							reset$={reset$}
							update={update}
						/>
					))}
				</TableBody>
			</Table>
			<ComboBox
				title={tr.text(RBAC_Msgs.permissionPicker())}
				placeholder={tr.text(RBAC_Msgs.addPermission())}
				className="w-[20rem]"
				value={undefined}
				options={addOptions}
				onSelect={(type) => type && setRows([...rows, PermRows.newRow(type)])}
			/>
		</div>
	)
}

type PermRowViewProps = {
	roleId: string
	row: PermRows.PermRow
	subsumed: boolean
	timeout$: ValueState
	layerRequests$: ValueState
	reset$: Rx.Subject<void>
	update: RbacUpdate
}

// Typing a timeout or a request cap changes one row, so the rows compare by value and only that row re-renders. Edits
// re-derive the rows from the config they apply to, which keeps the handlers free of the rendered rows.
const PermRowView = React.memo(
	function PermRowView({ roleId, row, subsumed, timeout$, layerRequests$, reset$, update }: PermRowViewProps) {
		// `quiet` is threaded through for the timeout duration cell, whose uncontrolled input would be clobbered by a reset$
		function patchRow(id: string, patch: Partial<PermRows.PermRow>, quiet?: boolean) {
			update(
				(r) =>
					withRoleConfig(r, roleId, (c) =>
						PermRows.configFromRows(
							c,
							PermRows.rowsFromConfig(c).map((other) => (other.id === id ? { ...other, ...patch } : other)),
						),
					),
				quiet,
			)
		}
		function removeRow(id: string) {
			update((r) =>
				withRoleConfig(r, roleId, (c) =>
					PermRows.configFromRows(
						c,
						PermRows.rowsFromConfig(c).filter((other) => other.id !== id),
					),
				),
			)
		}
		return (
			<TableRow className={cn(subsumed && 'opacity-50')}>
				<TableCell className="align-top">
					<Select
						value={row.effect}
						disabled={!PermRows.canDeny(row.type)}
						onValueChange={(v) => patchRow(row.id, { effect: v as PermRows.Effect })}
					>
						<SelectTrigger className="h-8">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="allow">{tr.text(RBAC_Msgs.allow())}</SelectItem>
							<SelectItem value="deny">{tr.text(RBAC_Msgs.deny())}</SelectItem>
						</SelectContent>
					</Select>
				</TableCell>
				<TableCell className="align-top">
					<div className="flex items-start gap-1">
						<code className="text-xs leading-8">
							{row.type === PermRows.ALL_PERMISSIONS ? tr.text(RBAC_Msgs.allPermissions()) : row.type}
						</code>
						{PermRows.permDescription(row.type) && <HelpTip text={tr.text(PermRows.permDescription(row.type)!)} />}
						{subsumed && (
							<Tooltip>
								<TooltipTrigger asChild>
									<Icons.Info className="mt-2 h-3 w-3 shrink-0 text-muted-foreground" />
								</TooltipTrigger>
								<TooltipContent>{tr.text(RBAC_Msgs.subsumedByWildcard())}</TooltipContent>
							</Tooltip>
						)}
					</div>
				</TableCell>
				<TableCell className="align-top">
					<PermScopeCell row={row} timeout$={timeout$} layerRequests$={layerRequests$} reset$={reset$} onPatch={patchRow} />
				</TableCell>
				<TableCell className="align-top">
					{/* a trash can, not an X: the scope cell's own X drops a single scope value, and the two end up close
					    enough that reusing the icon for "remove the whole permission" would be a trap */}
					<Tooltip help>
						<TooltipTrigger asChild>
							<Button
								type="button"
								size="icon"
								variant="ghost"
								className="h-8 w-8 text-destructive"
								onClick={() => removeRow(row.id)}
							>
								<Icons.Trash2 className="h-4 w-4" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>{tr.text(RBAC_Msgs.removePermission())}</TooltipContent>
					</Tooltip>
				</TableCell>
			</TableRow>
		)
	},
	(prev, next) =>
		prev.roleId === next.roleId &&
		prev.subsumed === next.subsumed &&
		prev.timeout$ === next.timeout$ &&
		prev.layerRequests$ === next.layerRequests$ &&
		prev.reset$ === next.reset$ &&
		prev.update === next.update &&
		Obj.deepEqual(prev.row, next.row),
)

// the Scope cell is a switch over the permission's scope kind, so a new permission needs no new editor: it inherits the
// cell for whichever scope it declares in PERMISSION_DEFINITION.
function PermScopeCell({
	row,
	timeout$,
	layerRequests$,
	reset$,
	onPatch,
}: {
	row: PermRows.PermRow
	timeout$: ValueState
	layerRequests$: ValueState
	reset$: Rx.Subject<void>
	onPatch: (id: string, patch: Partial<PermRows.PermRow>, quiet?: boolean) => void
}) {
	const servers = Zus.useStore(SettingsClient.PublicSettingsStore, (s) => s?.servers) ?? []

	// a denial is unrestricted by construction: the expression grammar carries no args
	if (row.effect === 'deny') return <span className="text-xs leading-8 text-muted-foreground">{tr.text(RBAC_Msgs.scopeEverything())}</span>

	const scope = PermRows.rowScope(row.type)
	switch (scope) {
		case 'all':
		case 'global':
			return (
				<span className="text-xs leading-8 text-muted-foreground">
					{scope === 'all' ? tr.text(RBAC_Msgs.scopeEverything()) : tr.text(RBAC_Msgs.scopeNone())}
				</span>
			)

		case 'timeout':
			return (
				<div className="flex items-center gap-2">
					<span className="text-xs text-muted-foreground">{tr.text(RBAC_Msgs.scopeUpTo())}</span>
					<div className="w-24">
						<TextInputField
							value$={timeout$}
							reset$={reset$}
							onChange={(v) => onPatch(row.id, { maxTimeout: (v as string) || PermRows.DEFAULT_MAX_TIMEOUT }, true)}
							numeric={false}
							placeholder={tr.text(RBAC_Msgs.maxTimeoutPlaceholder())}
						/>
					</div>
				</div>
			)

		case 'layer-requests':
			return (
				<div className="flex items-center gap-2">
					<span className="text-xs text-muted-foreground">{tr.text(RBAC_Msgs.scopeUpTo())}</span>
					<div className="w-24">
						<TextInputField
							value$={layerRequests$}
							reset$={reset$}
							onChange={(v) =>
								onPatch(
									row.id,
									{
										maxLayerRequests:
											typeof v === 'number' && Number.isFinite(v) && v >= 1
												? Math.floor(v)
												: PermRows.DEFAULT_MAX_LAYER_REQUESTS,
									},
									true,
								)
							}
							numeric={true}
							placeholder={String(PermRows.DEFAULT_MAX_LAYER_REQUESTS)}
						/>
					</div>
					<span className="text-xs text-muted-foreground">{tr.text(RBAC_Msgs.scopeConcurrentRequests())}</span>
				</div>
			)

		case 'global-settings-write':
			return (
				<ScopeValueRows
					kind="setting-path"
					mono
					emptyLabel={tr.text(RBAC_Msgs.scopeAllSettings())}
					values={row.paths ?? []}
					options={globalGrantPathOptions()}
					onChange={(paths) => onPatch(row.id, { paths })}
				/>
			)

		case 'server':
		case 'server-settings':
			return (
				<ScopeValueRows
					kind="server"
					emptyLabel={tr.text(RBAC_Msgs.scopeAllServers())}
					values={row.serverIds ?? []}
					options={serverOptionsFor(servers, row.serverIds ?? [])}
					onChange={(serverIds) => onPatch(row.id, { serverIds })}
				/>
			)

		case 'server-settings-write':
			return (
				// two independent lists in one cell, so they get more room between them than the rows within each
				<div className="space-y-3">
					<ScopeValueRows
						kind="server"
						emptyLabel={tr.text(RBAC_Msgs.scopeAllServers())}
						values={row.serverIds ?? []}
						options={serverOptionsFor(servers, row.serverIds ?? [])}
						onChange={(serverIds) => onPatch(row.id, { serverIds })}
					/>
					<ScopeValueRows
						kind="setting-path"
						mono
						emptyLabel={tr.text(RBAC_Msgs.scopeAllNonSensitiveSettings())}
						values={row.paths ?? []}
						options={serverGrantPathOptions()}
						onChange={(paths) => onPatch(row.id, { paths })}
					/>
				</div>
			)

		default:
			return assertNever(scope)
	}
}

// One dropdown per selected value rather than a single multi-select: the values here are long (dotted setting paths,
// `Display Name (server-id)`) and a combined trigger could only show them comma-joined and ellipsed, which truncated
// exactly the tail that distinguishes them.
function ScopeValueRows({
	kind,
	values,
	options,
	onChange,
	emptyLabel,
	mono,
}: {
	kind: RBAC_Msgs.ScopeValueKind
	values: string[]
	options: (ComboBoxOption<string> | string)[]
	onChange: (next: string[]) => void
	// an empty scope means unrestricted, which reads as a bug unless it's spelled out
	emptyLabel: string
	mono?: boolean
}) {
	const labels = RBAC_Msgs.scopeValueLabels[kind]
	const normalized: ComboBoxOption<string>[] = options.map((o) => (typeof o === 'string' ? { value: o } : o))
	const selected = new Set(values)
	const exhausted = normalized.every((o) => selected.has(o.value))

	// a value already used in a sibling row would be a no-op grant, so only the row holding it may keep it
	function optionsFor(own?: string): ComboBoxOption<string>[] {
		return normalized.map((o) => (o.value !== own && selected.has(o.value) ? { ...o, disabled: true } : o))
	}
	const boxClass = cn('w-full max-w-[22rem]', mono && 'font-mono')

	return (
		<ListEditor
			items={values}
			itemKey={(value) => value}
			emptyLabel={emptyLabel}
			addLabel={labels.add}
			addDisabled={exhausted}
			onRemove={(_, idx) => onChange(values.filter((_, i) => i !== idx))}
			renderItem={(value, idx) => (
				<ComboBox
					title={labels.title}
					className={boxClass}
					value={value}
					options={optionsFor(value)}
					onSelect={(next) => next && onChange(values.map((v, i) => (i === idx ? next : v)))}
				/>
			)}
			renderAddControl={({ ref, done }) => (
				<ComboBox
					ref={ref}
					title={labels.title}
					className={boxClass}
					placeholder={labels.select}
					value={undefined}
					options={optionsFor()}
					onSelect={(next) => {
						if (next) onChange([...values, next])
						done()
					}}
				/>
			)}
		/>
	)
}
