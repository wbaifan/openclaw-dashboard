# Feature: Customizable Footer with Emoji Picker

## Summary

This PR adds the ability for users to customize the dashboard footer with their own name and emoji, with persistent storage in the browser's localStorage.

## Features

### 1. Editable Name
- Click on the footer name to enter edit mode
- Press `Enter` to save, `Escape` to cancel
- Changes persist in browser localStorage

### 2. Emoji Picker
- Click on the emoji icon in edit mode to open emoji picker
- 64 commonly used emojis organized in categories:
  - Sea creatures: 🦐 🦀 🦞 🐙 🦑 🐬 🐳 🐋 🦈
  - Space: 🚀 ✈️ 🛸 🛰️ 🌍 🌎 🌏 🌐
  - People: 🤖 🧚‍♂️ 🧚‍♀️ 🦸 🦹 👨‍💻 👩‍💻 🧙
  - And more...

### 3. Persistent Storage
- Name and emoji are saved to localStorage
- Survives page refreshes and browser restarts
- Keys: `openclaw-dashboard-name` and `openclaw-dashboard-emoji`

## Technical Details

### Files Changed
- `packages/web/src/components/Footer.tsx` - Main component with edit functionality
- `packages/web/src/style.css` - Styling for emoji picker and edit mode

### Implementation
- Uses React hooks (useState, useEffect, useRef)
- Emoji picker positioned above footer for better UX
- Click outside to close emoji picker
- Keyboard shortcuts for edit mode (Enter/Escape)

## Screenshots

**Normal mode:**
```
[🦐 OpenClaw Dashboard]  |  更新于: 刚刚  |  WS: live
```

**Edit mode:**
```
[🦐] [OpenClaw] [Dashboard]  |  更新于: 刚刚  |  WS: live
       ^ input field
```

**Emoji picker:**
```
┌─────────────────────────┐
│ 🦐 🌟 ⭐ 🔥 💫 ✨ 🌙 ☀️ │
│ 🦀 🦞 🐙 🦑 🐬 🐳 🐋 🦈 │
│ ...                     │
└─────────────────────────┘
```

## Testing

1. Open dashboard at http://localhost:3210
2. Click on "🦐 OpenClaw Dashboard" in footer
3. Edit name and press Enter
4. Click emoji to open picker
5. Select new emoji
6. Refresh page - changes persist

## Breaking Changes

None. This is a pure additive feature.

## Future Enhancements

- Add more emoji categories
- Allow custom emoji input
- Sync across devices (optional)
