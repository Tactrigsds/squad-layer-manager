export const LOADING = '__LOADING__'

// See ui/menu-sizing.ts for the bounds and sizing.ts for why the width only grows while open. The option pane
// carries the max width rather than the popover, so ComboBoxMulti's selection pane can sit beside it.
export const POPOVER_SIZING_CLASSES = 'flex flex-col overflow-visible w-max max-w-(--radix-popover-content-available-width)'
