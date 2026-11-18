import { toast } from '@/lib/toast'
import * as APP_Msgs from '@/messages/app.messages'
import { tr } from '@/systems/messages.client'

// Writes `text` to the clipboard. `what` names it in a one-line receipt toast; a caller that confirms the copy in place
// omits it. A refused write always toasts an error. Resolves to whether the write succeeded.
export async function copy(text: string, what?: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text)
	} catch {
		toast.error(...tr.toast(APP_Msgs.copyFailed()))
		return false
	}
	if (what !== undefined) toast(...tr.toast(APP_Msgs.copiedToClipboard(what)))
	return true
}
