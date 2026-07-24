import type * as BAL from '@/models/balance-triggers.models'
import { AlertOctagon, AlertTriangle, Info, type LucideIcon } from 'lucide-react'

// How a balance trigger level presents: the alert it raises on the match history, and the preview of that alert the
// settings editor shows beside the level picker. Shared so the two can never drift apart.
export const TRIGGER_LEVEL_DISPLAY: Record<
	BAL.TriggerWarnLevel,
	{ icon: LucideIcon; variant: 'destructive' | 'warning' | 'info'; text: string }
> = {
	violation: { icon: AlertOctagon, variant: 'destructive', text: 'text-destructive' },
	warn: { icon: AlertTriangle, variant: 'warning', text: 'text-warning' },
	info: { icon: Info, variant: 'info', text: 'text-info' },
}
