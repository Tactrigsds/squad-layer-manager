import { z } from 'zod'
import * as Zus from 'zustand'

// TODO combine with global-settings.ts
const THEME = z.enum(['dark', 'light', 'system'])
type Theme = z.infer<typeof THEME>

type ThemeStore = {
	theme: Theme
	setTheme: (theme: Theme) => void
}

const THEME_STORAGE_KEY = 'ui-theme:v1'

function applyTheme(theme: Theme) {
	const root = window.document.documentElement

	root.classList.remove('light', 'dark')

	if (theme === 'system') {
		const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'

		root.classList.add(systemTheme)
	} else {
		root.classList.add(theme)
	}
}

let ThemeStore!: Zus.StoreApi<ThemeStore>

export function setup() {
	ThemeStore = Zus.createStore<ThemeStore>((set) => {
		const theme = THEME.parse(localStorage.getItem(THEME_STORAGE_KEY) ?? 'dark')
		applyTheme(theme)
		return {
			theme,
			setTheme: (theme: Theme) => {
				applyTheme(theme)
				localStorage.setItem(THEME_STORAGE_KEY, theme)
				return set({ theme })
			},
		}
	})
}

export function useTheme() {
	return Zus.useStore(ThemeStore)
}
