import { def, t } from '@/models/messages.models'

export const ingameWarn = def((message: string) => ({ warn: t('SLM: {message}', { message }) }))

export const bannerLabel = def('Announcement')
