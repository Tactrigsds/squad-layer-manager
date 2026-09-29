import * as Icons from 'lucide-react'

import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import * as Zus from '@/lib/zustand'
import * as ANN_Msgs from '@/messages/announcements.messages'
import * as UI_Msgs from '@/messages/ui.messages'
import * as AnnouncementsClient from '@/systems/announcements.client'
import { tr } from '@/systems/messages.client'

export default function AnnouncementBanner() {
	const announcement = Zus.useStore(AnnouncementsClient.Store, AnnouncementsClient.Sel.visible)
	if (!announcement) return null
	return (
		<Alert
			variant="warning"
			aria-label={tr.text(ANN_Msgs.bannerLabel())}
			className="grid-cols-[16px_1fr_auto] items-center rounded-none border-x-0 border-t-0"
		>
			<Icons.Megaphone />
			<span className="whitespace-pre-wrap">{announcement.message}</span>
			<Button variant="ghost" size="icon-sm" onClick={AnnouncementsClient.Actions.dismiss} aria-label={tr.text(UI_Msgs.close())}>
				<Icons.X />
			</Button>
		</Alert>
	)
}
