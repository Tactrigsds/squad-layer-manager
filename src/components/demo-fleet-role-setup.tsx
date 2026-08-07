import { useMutation, useQuery } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React from 'react'

import { DiscordRoleSelect } from '@/components/discord-picker'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { toast } from '@/lib/toast'
import { assertNever } from '@/lib/type-guards'
import * as DF_Msgs from '@/messages/demo-fleet.messages'
import * as RPC from '@/orpc.client'
import { tr } from '@/systems/messages.client'

// Shown once on a demo-fleet guild instance, to the first person holding Manage Server to sign in. Everywhere else
// setupState answers `applies: false` and this renders nothing.
export default function DemoFleetRoleSetup() {
	const stateRes = useQuery(RPC.orpc.demoFleet.setupState.queryOptions({ staleTime: Infinity }))
	const [roleId, setRoleId] = React.useState('')
	const [dismissed, setDismissed] = React.useState(false)

	const choose = useMutation(
		RPC.orpc.demoFleet.chooseFullAccessRole.mutationOptions({
			onSuccess: (result) => {
				switch (result.code) {
					case 'ok':
						toast(...tr.toast(DF_Msgs.roleSetupSaved()))
						void stateRes.refetch()
						return
					case 'err:already-chosen':
						toast.error(...tr.toast(DF_Msgs.roleSetupAlreadyChosen()))
						void stateRes.refetch()
						return
					case 'err:permission-denied':
					case 'err:not-a-demo-instance':
						toast.error(...tr.toast(DF_Msgs.roleSetupFailed()))
						return
					default:
						assertNever(result)
				}
			},
			onError: () => toast.error(...tr.toast(DF_Msgs.roleSetupFailed())),
		}),
	)

	const state = stateRes.data
	if (!state?.applies || state.chosenRoleId !== null || !state.canChoose) return null

	return (
		<Dialog modal open={!dismissed} onOpenChange={(open) => setDismissed(!open)}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{tr.text(DF_Msgs.roleSetupTitle())}</DialogTitle>
					<DialogDescription>{tr.text(DF_Msgs.roleSetupBlurb())}</DialogDescription>
				</DialogHeader>

				<div className="space-y-2">
					<Label htmlFor="full-access-role">{tr.text(DF_Msgs.roleSetupFieldLabel())}</Label>
					<DiscordRoleSelect value={roleId} onChange={setRoleId} disabled={choose.isPending} />
					<p className="text-xs text-muted-foreground">{tr.text(DF_Msgs.roleSetupNote())}</p>
				</div>

				<DialogFooter>
					<Button disabled={!roleId || choose.isPending} onClick={() => choose.mutate({ roleId })}>
						{choose.isPending && <Icons.Loader2 className="mr-2 h-4 w-4 animate-spin" />}
						{tr.text(DF_Msgs.roleSetupConfirm())}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
