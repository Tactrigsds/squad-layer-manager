/**
 * SLM's own building blocks, so a plugin's slot looks like the page it is on: the alert the host renders a
 * decoration with, badges, buttons, cards and tooltips. The app's stylesheet styles them, so a plugin built
 * from these needs no utilities of its own.
 */
export { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
export { Badge } from '@/components/ui/badge'
export type { BadgeProps } from '@/components/ui/badge'
export { Button } from '@/components/ui/button'
export type { ButtonProps } from '@/components/ui/button'
export { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
export { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
