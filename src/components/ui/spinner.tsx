import { Loader2Icon } from 'lucide-react'

import { cn } from '@/lib/utils'
import * as UI_Msgs from '@/messages/ui.messages'

function Spinner({ className, ...props }: React.ComponentProps<'svg'>) {
	return <Loader2Icon role="status" aria-label={UI_Msgs.loading().text()} className={cn('size-4 animate-spin', className)} {...props} />
}

export { Spinner }
