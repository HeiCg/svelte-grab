# svelte-grab

Click any element to get the component stack with source locations. Makes coding agents (Claude, Cursor, Copilot) significantly faster for UI changes.

Inspired by [React Grab](https://github.com/aidenybai/react-grab) which demonstrated 3x speedup for React projects.

## The Problem

Coding agents are slow at frontend because translating intent is lossy:

1. You want to change a button's spacing
2. You describe it: "make the button in the header bigger"
3. The agent searches the codebase (grep, glob, multiple attempts)
4. Eventually finds the file and makes the change

This search phase is slow and non-deterministic.

## The Solution

SvelteGrab eliminates the search phase by giving the agent exact file locations:

1. Alt+Click the element you want to change
2. Component stack with file paths is copied to clipboard
3. Paste into your agent prompt
4. Agent jumps directly to the right file

```
in element at src/lib/components/Header.svelte:42
in component at src/routes/+layout.svelte:15
```

## Installation

```bash
npm install svelte-grab
```

## Usage

Add to your root layout (works only in development mode):

```svelte
<!-- src/routes/+layout.svelte -->
<script>
  import { SvelteGrab } from 'svelte-grab';
</script>

<slot />
<SvelteGrab />
```

Then:

1. **Alt+Click** (Option+Click on Mac) any element
2. Component stack is automatically copied to clipboard
3. Paste into your coding agent prompt

## Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `modifier` | `'alt' \| 'ctrl' \| 'meta' \| 'shift'` | `'alt'` | Keyboard modifier to trigger grab |
| `autoCopyFormat` | `'agent' \| 'paths' \| 'none'` | `'agent'` | Format for auto-copy on grab |
| `showPopup` | `boolean` | `true` | Show visual popup (set false for clipboard-only) |
| `forceEnable` | `boolean` | `false` | Force enable even if dev detection fails |
| `theme` | `object` | - | Custom theme colors |

### Clipboard-only mode

For minimal UI distraction:

```svelte
<SvelteGrab showPopup={false} />
```

Output appears in console and clipboard only.

### Custom modifier key

```svelte
<SvelteGrab modifier="ctrl" />
```

### Custom theme

```svelte
<SvelteGrab
  theme={{
    background: '#0d1117',
    border: '#30363d',
    text: '#c9d1d9',
    accent: '#58a6ff'
  }}
/>
```

## Output Formats

### Agent Format (default)

Optimized for pasting into coding agent prompts:

```
in element at src/lib/components/Button.svelte:23
in component at src/lib/components/Form.svelte:45
in component at src/routes/contact/+page.svelte:12
```

### Paths Format

Simple file:line:column format:

```
src/lib/components/Button.svelte:23:5
src/lib/components/Form.svelte:45:3
src/routes/contact/+page.svelte:12:1
```

## How It Works

Svelte 5 attaches `__svelte_meta` to DOM elements in development mode containing:

- `loc.file` - Source filename
- `loc.line` - Line number
- `loc.column` - Column number
- `parent` - Link to parent component stack

SvelteGrab walks up this metadata tree to build the full component hierarchy.

## Requirements

- Svelte 5.x
- Development mode (`DEV=true`)

The component automatically disables itself in production builds.

## License

MIT
