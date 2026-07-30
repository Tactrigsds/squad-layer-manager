import { Loader2Icon } from 'lucide-react'

import { cn } from '@/lib/utils'
import * as UI_Msgs from '@/messages/ui.messages'
import { tr } from '@/systems/messages.client'

function Spinner({ className, ...props }: React.ComponentProps<'svg'>) {
	return <Loader2Icon role="status" aria-label={tr.text(UI_Msgs.loading())} className={cn('size-4 animate-spin', className)} {...props} />
}

export { Spinner }
