// Sizing shared by every dropdown menu (Select, ComboBox, ComboBoxMulti). A menu takes its options' natural width
// between these bounds and ignores its trigger's width: a full-width field holding three short options would
// otherwise open a menu as wide as the page. Both bounds scale with the UI's font size.
export const MENU_MIN_WIDTH_CLASS = 'min-w-48'
// an option longer than this truncates rather than widening the menu
export const MENU_MAX_WIDTH_CLASS = 'max-w-[28rem]'
// ten and a half rows, so a list that scrolls shows a cut-off row at the bottom
export const MENU_LIST_MAX_HEIGHT_CLASS = 'max-h-[calc(var(--mi-h)*10.5)]'
