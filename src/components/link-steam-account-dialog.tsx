import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { toast } from '@/lib/toast'
import { Steam64IdSchema } from '@/lib/zod'
import * as UsersClient from '@/systems/users.client'
import * as Icons from 'lucide-react'
import React from 'react'

// keeps a trailing empty slot so the list auto-expands as the user fills the last input
function withTrailingBlank(ids: string[]): string[] {
	if (ids.length === 0 || ids[ids.length - 1].trim() !== '') return [...ids, '']
	return ids
}

export default function LinkSteamAccountDialog(
	props: { children: React.ReactNode; open?: boolean; onOpenChange?: (newState: boolean) => void },
) {
	const linkedQuery = UsersClient.useMyLinkedSteamAccounts()
	return (
		<Dialog modal open={props.open} onOpenChange={props.onOpenChange}>
			<DialogTrigger asChild>
				{props.children}
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Linked Steam Accounts</DialogTitle>
					<DialogDescription>
						Link your Steam64 IDs so in-game admin commands (like /kick) recognize you. Add as many as you need.
					</DialogDescription>
				</DialogHeader>
				{linkedQuery.data?.code === 'ok'
					// mounts once per dialog open (DialogContent unmounts on close), seeding the draft from the query in
					// the state initializer: a background refetch (e.g. on window refocus, likely while the user tabs to
					// Steam to copy their ID) must not clobber their in-progress edits
					? <LinkedSteamAccountsEditor initialIds={linkedQuery.data.steamIds} onClose={() => props.onOpenChange?.(false)} />
					: <p className="text-sm text-muted-foreground">Loading...</p>}
			</DialogContent>
		</Dialog>
	)
}

function LinkedSteamAccountsEditor({ initialIds, onClose }: { initialIds: readonly string[]; onClose: () => void }) {
	const updateMutation = UsersClient.useUpdateLinkedSteamAccountsMutation()
	const [ids, setIds] = React.useState<string[]>(() => withTrailingBlank([...initialIds]))

	function setId(idx: number, value: string) {
		setIds((prev) => withTrailingBlank(prev.map((v, i) => (i === idx ? value : v))))
	}
	function removeId(idx: number) {
		setIds((prev) => withTrailingBlank(prev.filter((_, i) => i !== idx)))
	}

	const nonEmpty = ids.map(v => v.trim()).filter(Boolean)
	const rowError = (value: string): string | null => {
		const v = value.trim()
		if (!v) return null
		if (!Steam64IdSchema.safeParse(v).success) return 'Must be a 17-digit Steam64 ID'
		if (nonEmpty.filter(o => o === v).length > 1) return 'Duplicate'
		return null
	}
	const hasErrors = ids.some(v => rowError(v) !== null)

	async function handleSave() {
		if (hasErrors) return
		const res = await updateMutation.mutateAsync([...new Set(nonEmpty)])
		if (res.code === 'ok') {
			toast('Linked Steam accounts updated')
			onClose()
		} else if (res.code === 'err:steam-already-linked') {
			toast.error('Steam ID already linked', { description: `${res.steamId} is linked to another account.` })
		} else {
			toast.error('Failed to update', { description: res.msg })
		}
	}

	return (
		<>
			<div className="space-y-2">
				{ids.map((value, idx) => {
					const error = rowError(value)
					const isTrailingBlank = idx === ids.length - 1 && value.trim() === ''
					return (
						// list rows have no stable id; index is the pragmatic key
						// oxlint-disable-next-line no-array-index-key
						<div key={idx} className="space-y-1">
							<div className="flex items-center gap-2">
								<Input
									autoComplete="off"
									inputMode="numeric"
									placeholder="17-digit Steam64 ID"
									value={value}
									onChange={(e) => setId(idx, e.target.value)}
									disabled={updateMutation.isPending}
								/>
								<Button
									type="button"
									size="icon"
									variant="ghost"
									className="h-8 w-8 text-destructive shrink-0"
									disabled={isTrailingBlank || updateMutation.isPending}
									onClick={() => removeId(idx)}
								>
									<Icons.X className="h-4 w-4" />
								</Button>
							</div>
							{error && <p className="text-xs text-destructive pl-1">{error}</p>}
						</div>
					)
				})}
			</div>

			<DialogFooter className="flex flex-col sm:flex-row gap-2">
				<Button variant="outline" onClick={onClose} disabled={updateMutation.isPending}>
					Cancel
				</Button>
				<Button onClick={handleSave} disabled={hasErrors || updateMutation.isPending}>
					{updateMutation.isPending && <Icons.Loader2 className="mr-2 h-4 w-4 animate-spin" />}
					{updateMutation.isPending ? 'Saving...' : 'Save'}
				</Button>
			</DialogFooter>
		</>
	)
}
