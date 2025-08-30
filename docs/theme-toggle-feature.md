# Theme Toggle Feature

## Overview
Added a theme toggle feature to the user avatar dropdown menu in the Squad Layer Manager application. This allows users to switch between Dark, Light, and System theme preferences.

## Implementation Details

### Location
The theme toggle has been added to the user avatar dropdown menu in the top navigation bar.

### Available Options
- **Light Theme** - Forces light mode with a sun icon
- **Dark Theme** - Forces dark mode with a moon icon
- **System Theme** - Follows the operating system's theme preference with a monitor icon

### Technical Changes

#### Modified Files
1. **`src/components/app-container.tsx`**
   - Added theme toggle as a submenu in the user dropdown
   - Imported additional dropdown components (DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator)
   - Added Icons for theme options (Sun, Moon, Monitor, Palette)
   - Destructured `setTheme` from the `ThemeClient.useTheme()` hook

2. **`src/systems.client/theme.ts`**
   - Fixed the `ThemeStore` initialization by properly assigning the store in the setup function
   - The store was previously declared but not assigned when created

### User Experience
1. Click on your avatar in the top-right corner
2. In the dropdown menu, hover over or click "Theme"
3. A submenu will appear with three radio button options
4. Select your preferred theme:
   - Light
   - Dark
   - System (default)
5. The theme will be applied immediately and saved to localStorage

### Features
- **Persistent Storage**: Theme preference is saved to localStorage and persists across sessions
- **Immediate Application**: Theme changes are applied instantly without page reload
- **System Integration**: System option respects the OS dark/light mode preference
- **Visual Feedback**: Radio buttons show the currently selected theme

### Code Structure
The theme system uses:
- Zustand for state management
- localStorage for persistence (key: `ui-theme:v1`)
- CSS class manipulation on the document root element
- Media query detection for system theme preference

### Visual Design
- Clean submenu integration with the existing dropdown
- Consistent icon usage from lucide-react library
- Proper separation from other menu items with a separator
- Responsive text sizing matching the rest of the menu items

## Testing
To test the feature:
1. Run the development server
2. Log in to access the user dropdown
3. Try switching between all three theme options
4. Verify that the theme persists after page refresh
5. Test system theme by changing your OS theme preference
