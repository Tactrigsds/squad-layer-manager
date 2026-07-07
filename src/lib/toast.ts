import type { ReactNode } from 'react'
import { type ExternalToast, toast as base } from 'sonner'

// Sonner's error/warning toasts look like a normal toast here because we don't turn on richColors
// globally. Opting each one into richColors gives sonner's tuned, readable palette (a pale tinted
// surface with a colored border, text and icon, light/dark aware) instead of a flat saturated fill.
// It deliberately leaves --normal-text alone, so the action button keeps its normal contrast.
function error(message: ReactNode, opts?: ExternalToast) {
	return base.error(message, { richColors: true, ...opts })
}

function warning(message: ReactNode, opts?: ExternalToast) {
	return base.warning(message, { richColors: true, ...opts })
}

// Re-export sonner's toast with error/warning defaulted to richColors so they actually read as
// error/warning. Import this instead of sonner's toast; every other method (info, success, dismiss,
// promise, plain toast()) is passed through unchanged.
export const toast = Object.assign((message: ReactNode, opts?: ExternalToast) => base(message, opts), base, { error, warning })
