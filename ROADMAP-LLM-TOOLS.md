# Roadmap: Context Tools for LLMs in Svelte Frontend

> Specification document for tools that improve the context available to LLMs when working with Svelte applications.

## Executive Summary

### The Problem

LLMs face significant limitations when helping frontend developers:

1. **Visual Blindness**: They cannot "see" the rendered output
2. **Invisible State**: They do not know the current values of variables/stores
3. **Opaque CSS**: They do not know the final style after cascading
4. **Obscured Data Flow**: Difficult to trace the origin of props
5. **Hidden Errors**: They have no access to the browser console
6. **Invisible Performance**: They cannot detect unnecessary re-renders
7. **Implicit A11y**: Accessibility issues are not obvious in the code

### The Solution

A suite of development tools that capture and format relevant context for LLMs, enabling more accurate diagnostics and more effective solutions.

---

## Tool 1: Svelte-State-Grab

### Description

Captures the current state of a component (props, $state variables, connected stores) and formats it in a structured manner for consumption by LLMs.

### Problem It Solves

When a developer says "the component is not working", the LLM does not know:
- What props the component is receiving
- Current values of reactive variables
- State of connected stores
- Whether the data is `undefined`, `null`, or unexpected values

### Example Output

```
=== Component State: ProductCard ===

📥 RECEIVED PROPS:
  product: { id: 123, name: "Widget", price: null, inStock: true }
  onAddToCart: [Function]
  quantity: 0

🔄 INTERNAL STATE ($state):
  isHovered: false
  selectedVariant: undefined
  localQuantity: 0

🏪 CONNECTED STORES:
  $cartStore: { items: [], total: 0 }
  $userStore: { isLoggedIn: true, id: "user_456" }

⚡ DERIVED VALUES ($derived):
  formattedPrice: "$ --" (price is null)
  canAddToCart: false (quantity === 0)

📍 Location: src/lib/components/ProductCard.svelte:1
```

### How It Works Technically

```
┌─────────────────────────────────────────────────────────┐
│                    Svelte-State-Grab                     │
├─────────────────────────────────────────────────────────┤
│  1. Intercepts click with modifier (Alt+Shift+Click)    │
│                         ↓                                │
│  2. Finds element with __svelte_meta                    │
│                         ↓                                │
│  3. Accesses component context via Svelte internals     │
│     - $$props (received props)                          │
│     - $$state (internal state)                          │
│     - Store context via getContext                      │
│                         ↓                                │
│  4. Serializes values (handling circular refs)          │
│                         ↓                                │
│  5. Formats output optimized for LLM                    │
│                         ↓                                │
│  6. Copies to clipboard / displays popup                │
└─────────────────────────────────────────────────────────┘
```

### Feasibility

| Aspect | Assessment | Notes |
|--------|------------|-------|
| Props access | ✅ Feasible | Svelte 5 exposes via `$props()` |
| $state access | ⚠️ Partial | Requires signal introspection |
| Store access | ⚠️ Partial | Global stores OK, contextual ones difficult |
| Serialization | ✅ Feasible | JSON.stringify with custom replacer |
| Circular refs | ✅ Feasible | Existing libraries (flatted) |

**Technical Challenges:**
1. Svelte 5 does not expose internal state directly like Svelte 4
2. Signals are private by design
3. Contextual stores require knowing the keys

**Possible Solutions:**
1. `$inspectable()` wrapper that the developer adds to expose state
2. Babel/Vite plugin that instruments components in dev
3. Use Svelte DevTools protocol (if available)

### Implementation Plan

#### Phase 1: MVP (1-2 weeks)
- [ ] Capture props via `$$props` or reflection
- [ ] Basic serialization with handling for functions and circular refs
- [ ] UI similar to SvelteGrab
- [ ] Text formatting for clipboard

#### Phase 2: Internal State (2-3 weeks)
- [ ] Research Svelte 5 internal APIs for signals
- [ ] Implement `$inspectable()` wrapper as an alternative
- [ ] Detect and list declared $state variables

#### Phase 3: Stores (1-2 weeks)
- [ ] Capture global stores (imported)
- [ ] Attempt to detect contextual stores
- [ ] Show current value and store type

#### Phase 4: Polish (1 week)
- [ ] Integration with SvelteGrab (same popup, different tab)
- [ ] State diff (before/after)
- [ ] Export as structured JSON

### Total Estimate: 5-8 weeks

---

## Tool 2: Svelte-Style-Grab

### Description

Captures the computed styles of an element and identifies the origin of each CSS property (component scoped, global, Tailwind, inline, etc.).

### Problem It Solves

CSS cascading is complex. When a developer asks "why is this button red?", the LLM needs to know:
- What the final computed style is
- Where each property comes from
- Which rule is "winning" (specificity)
- Whether there are conflicts or overrides

### Example Output

```
=== Styles for: <button class="btn primary"> ===

📐 BOX MODEL:
  width: 120px (auto → computed)
  height: 40px
  padding: 8px 16px → src/lib/Button.svelte:89 (.btn)
  margin: 0 → user-agent default

🎨 VISUAL:
  background: #3b82f6 → Tailwind (bg-blue-500)
  color: #ffffff → src/lib/Button.svelte:92 (.btn.primary)
  border: none → src/lib/Button.svelte:90 (.btn)
  border-radius: 8px → app.css:45 (.btn) ⚠️ OVERRIDDEN by specificity

📝 TYPOGRAPHY:
  font-size: 14px → Tailwind (text-sm)
  font-weight: 600 → src/lib/Button.svelte:95 (.btn)
  font-family: Inter, sans-serif → :root (global)

🔀 CONFLICTS DETECTED:
  ⚠️ border-radius: defined in 2 places
     - app.css:45 (.btn) → 4px [LOST - specificity 0,1,0]
     - Button.svelte:91 (.btn) → 8px [WON - specificity 0,1,0 + scoped]

📍 Element: src/lib/Button.svelte:12
```

### How It Works Technically

```
┌─────────────────────────────────────────────────────────┐
│                    Svelte-Style-Grab                     │
├─────────────────────────────────────────────────────────┤
│  1. Captures target element                             │
│                         ↓                                │
│  2. window.getComputedStyle(element)                    │
│     → Gets all final styles                             │
│                         ↓                                │
│  3. document.styleSheets iteration                      │
│     → Finds rules that match the element                │
│                         ↓                                │
│  4. For each property:                                  │
│     - Calculates specificity of each rule               │
│     - Identifies origin (file:line)                     │
│     - Detects if there is a conflict                    │
│                         ↓                                │
│  5. Groups by category (box model, visual, etc.)        │
│                         ↓                                │
│  6. Formats and exports                                 │
└─────────────────────────────────────────────────────────┘
```

### Feasibility

| Aspect | Assessment | Notes |
|--------|------------|-------|
| Computed styles | ✅ Feasible | Native browser API |
| Matching rules | ✅ Feasible | CSSOM + element.matches() |
| Source maps | ⚠️ Partial | Requires CSS source maps |
| Tailwind classes | ✅ Feasible | Detectable by class naming pattern |
| Scoped styles | ⚠️ Partial | Svelte adds hash, traceable |
| Specificity calc | ✅ Feasible | Well-known algorithm |

**Technical Challenges:**
1. CSS source maps are not always available
2. Tailwind JIT generates classes dynamically
3. CSS-in-JS is difficult to trace
4. Shadow DOM isolates styles

**Possible Solutions:**
1. Vite plugin that injects origin metadata into CSS
2. Heuristics to identify Tailwind (naming patterns)
3. For scoped styles, use the hash as identifier

### Implementation Plan

#### Phase 1: Computed Styles (1 week)
- [ ] Capture complete getComputedStyle
- [ ] Group by semantic categories
- [ ] Visualization UI

#### Phase 2: Rule Matching (2 weeks)
- [ ] Iterate styleSheets and find matches
- [ ] Calculate specificity of each rule
- [ ] Sort by "which one wins"

#### Phase 3: Source Attribution (2-3 weeks)
- [ ] Detect Svelte scoped styles (by hash)
- [ ] Detect Tailwind classes (by pattern)
- [ ] Use source maps when available
- [ ] Fallback: show CSS file without line number

#### Phase 4: Conflict Detection (1 week)
- [ ] Identify properties defined multiple times
- [ ] Explain which rule "won" and why
- [ ] Suggest fixes for conflicts

### Total Estimate: 6-7 weeks

---

## Tool 3: Svelte-Props-Tracer

### Description

Traces the complete chain of where each prop came from, from the root component to the current component, including intermediate transformations.

### Problem It Solves

In deep component trees, it is difficult to know:
- Where a prop originally came from
- Which intermediate components passed it along
- Whether there were transformations along the way
- Why the prop has an unexpected value

### Example Output

```
=== Props Trace: <UserAvatar> ===

🔍 PROP: user
  Current value: { name: "John", avatar: null }
  Type: Object

📍 ORIGIN CHAIN:

  [1] +page.svelte:15
      │ const user = await load() // { name: "John", avatar: "url..." }
      │ <UserProfile {user} />
      ↓
  [2] UserProfile.svelte:8
      │ let { user } = $props()
      │ const displayUser = { ...user, avatar: user.avatar || null }
      │                                        ^^^^^^^^^^^^^^^^
      │                                        ⚠️ TRANSFORMATION: avatar became null
      │ <UserAvatar user={displayUser} />
      ↓
  [3] UserAvatar.svelte:3 ← YOU ARE HERE
      │ let { user } = $props()
      │ // user.avatar is null

💡 INSIGHT:
  The avatar was "url..." at the origin but was transformed to null
  in UserProfile.svelte:9 by the expression: user.avatar || null

  This happens because || treats empty string as falsy.
  Suggestion: use ?? instead of ||
```

### How It Works Technically

```
┌─────────────────────────────────────────────────────────┐
│                   Svelte-Props-Tracer                    │
├─────────────────────────────────────────────────────────┤
│  COMPILATION (Vite Plugin):                             │
│  1. Instruments each prop passing                       │
│  2. Adds origin metadata                                │
│  3. Wraps values with Proxy for tracking                │
├─────────────────────────────────────────────────────────┤
│  RUNTIME:                                               │
│  1. When passing prop, registers in trace stack         │
│  2. Detects transformations (value changed)             │
│  3. Maintains history per component                     │
├─────────────────────────────────────────────────────────┤
│  CAPTURE (Click):                                       │
│  1. Accesses component's trace stack                    │
│  2. Reconstructs origin chain                           │
│  3. Identifies where changes occurred                   │
│  4. Formats for output                                  │
└─────────────────────────────────────────────────────────┘
```

### Feasibility

| Aspect | Assessment | Notes |
|--------|------------|-------|
| Props tracking | ⚠️ Complex | Requires instrumentation |
| Vite plugin | ✅ Feasible | Well-documented APIs |
| Svelte compiler hook | ⚠️ Partial | Preprocessor is limited |
| Runtime overhead | ⚠️ Medium | Proxies have a cost |
| Source locations | ✅ Feasible | Compiler AST has info |

**Technical Challenges:**
1. Requires code modification at compile-time
2. Runtime overhead can be significant
3. Proxies do not work with all types
4. Spread props (`{...obj}`) are difficult to trace

**Possible Solutions:**
1. Opt-in per component (`<script trace>`)
2. Dev mode only with flag
3. Sampling instead of full tracking
4. Integration with Svelte DevTools

### Implementation Plan

#### Phase 1: Proof of Concept (2 weeks)
- [ ] Basic Vite plugin that instruments props
- [ ] Simple single-level tracking
- [ ] Validate performance overhead

#### Phase 2: Deep Tracking (3 weeks)
- [ ] Multi-level tracking (full tree)
- [ ] Detect value transformations
- [ ] Maintain efficient stack trace

#### Phase 3: Transformations (2 weeks)
- [ ] Identify where values changed
- [ ] Show expression that caused the change
- [ ] Suggest common fixes (|| vs ??)

#### Phase 4: Integration (1 week)
- [ ] Tree visualization UI
- [ ] Integration with SvelteGrab
- [ ] Export for LLM

### Total Estimate: 8-10 weeks

---

## Tool 4: Svelte-A11y-Reporter

### Description

Analyzes an element and its subtree to identify accessibility issues, with clear explanations and fix suggestions.

### Problem It Solves

Accessibility issues are not visible in the code:
- Insufficient contrast
- Missing labels on inputs
- Incorrect focus order
- Missing ARIA attributes
- Images without alt text

### Example Output

```
=== Accessibility Report: <form class="login-form"> ===

🔴 CRITICAL (3):

  1. Input without associated label
     │ <input type="email" placeholder="Email">
     │ Line: src/lib/LoginForm.svelte:15
     │
     │ ❌ Problem: Screen readers cannot identify the field
     │ ✅ Fix:
     │    <label for="email">Email</label>
     │    <input id="email" type="email">
     │
     │    Or use aria-label:
     │    <input type="email" aria-label="Email address">

  2. Button without accessible text
     │ <button><svg>...</svg></button>
     │ Line: src/lib/LoginForm.svelte:28
     │
     │ ❌ Problem: Button is read as "button" without context
     │ ✅ Fix:
     │    <button aria-label="Submit form">

  3. Insufficient contrast
     │ <span class="helper-text">Minimum 8 characters</span>
     │ Line: src/lib/LoginForm.svelte:22
     │
     │ ❌ Problem: Ratio 2.8:1 (minimum WCAG AA: 4.5:1)
     │    Foreground: #999999
     │    Background: #ffffff
     │ ✅ Fix: Use a darker color, e.g.: #767676 (4.5:1)

🟡 WARNINGS (2):

  1. Tab order may be confusing
     │ tabindex="5" on element
     │ ⚠️ Using positive tabindex breaks natural order

  2. Form without landmark
     │ <form> without role or aria-label
     │ ⚠️ Add aria-label="Login form"

🟢 GOOD (4):
  ✓ All inputs have type defined
  ✓ Form has submit button
  ✓ No unexpected autofocus
  ✓ Page language is defined

📊 SCORE: 65/100 (Needs improvement)
```

### How It Works Technically

```
┌─────────────────────────────────────────────────────────┐
│                   Svelte-A11y-Reporter                   │
├─────────────────────────────────────────────────────────┤
│  1. Captures element and subtree                        │
│                         ↓                                │
│  2. Runs test battery:                                  │
│     ├─ axe-core (a11y library)                          │
│     ├─ Contrast checker (WCAG)                          │
│     ├─ ARIA validator                                   │
│     ├─ Focus order analyzer                             │
│     └─ Semantic HTML checker                            │
│                         ↓                                │
│  3. Correlates with source locations                    │
│     (uses __svelte_meta for mapping)                    │
│                         ↓                                │
│  4. Generates fix suggestions                           │
│     (pre-defined templates by error type)               │
│                         ↓                                │
│  5. Formats report                                      │
└─────────────────────────────────────────────────────────┘
```

### Feasibility

| Aspect | Assessment | Notes |
|--------|------------|-------|
| axe-core integration | ✅ Feasible | Mature library |
| Contrast calculation | ✅ Feasible | WCAG algorithm |
| Source mapping | ✅ Feasible | __svelte_meta |
| Fix suggestions | ✅ Feasible | Templates |
| Real-time analysis | ⚠️ Partial | axe-core is heavy |

**Technical Challenges:**
1. axe-core bundle is large (~200kb)
2. Full analysis can be slow
3. Some issues require human context
4. False positives are common

**Possible Solutions:**
1. Lazy load axe-core
2. Cache results
3. Incremental analysis (only clicked element)
4. Whitelist of most relevant rules

### Implementation Plan

#### Phase 1: Core Integration (2 weeks)
- [ ] Integrate axe-core
- [ ] Single element analysis
- [ ] Basic issue output

#### Phase 2: Source Mapping (1 week)
- [ ] Map violations to source locations
- [ ] Use existing __svelte_meta

#### Phase 3: Fix Suggestions (2 weeks)
- [ ] Fix templates by error type
- [ ] Copy-paste ready suggested code
- [ ] Educational explanations

#### Phase 4: Contrast & Visual (1 week)
- [ ] Standalone contrast checker
- [ ] Visualization of issues in the DOM
- [ ] Color suggestions

#### Phase 5: Polish (1 week)
- [ ] Overall a11y score
- [ ] Integration with SvelteGrab
- [ ] Formatted export for LLM

### Total Estimate: 7-8 weeks

---

## Tool 5: Svelte-Error-Context

### Description

Collects errors and warnings from the console with enriched context, including clean stack traces, variable values at the time of error, and correlation with source code.

### Problem It Solves

LLMs do not have access to the browser console:
- Runtime errors are invisible
- Stack traces are cryptic
- They do not know the error context
- Important warnings go unnoticed

### Example Output

```
=== Captured Errors (last 5min) ===

🔴 ERROR [14:32:15]

  TypeError: Cannot read properties of undefined (reading 'name')

  📍 LOCATION:
     src/lib/UserCard.svelte:23

  📝 CODE:
     21 │ function displayName(user) {
     22 │   // user is undefined here
     23 │ → return user.name.toUpperCase()
     24 │ }

  🔍 CONTEXT AT THE TIME OF ERROR:
     user = undefined
     Called from: src/routes/+page.svelte:45
     Component props: { userId: "123", user: undefined }

  💡 PROBABLE CAUSE:
     The 'user' prop was not yet loaded (async) when
     displayName() was called.

  ✅ SUGGESTION:
     Add a check: user?.name?.toUpperCase() ?? 'Unknown'
     Or use {#if user} before rendering

───────────────────────────────────────

🟡 WARNING [14:32:10]

  [Svelte] <ProductList> received an unexpected slot "header"

  📍 src/routes/products/+page.svelte:12

  💡 The ProductList component does not define a "header" slot.
     Available slots: default, footer

───────────────────────────────────────

🟡 WARNING [14:31:55]

  [Svelte] Reactive statement has no reactive dependencies

  📍 src/lib/Counter.svelte:8

  📝 CODE:
     8 │ $: console.log('count changed') // Does not use 'count'

  💡 This $: will never re-execute.
     Fix to: $: console.log('count:', count)
```

### How It Works Technically

```
┌─────────────────────────────────────────────────────────┐
│                  Svelte-Error-Context                    │
├─────────────────────────────────────────────────────────┤
│  INTERCEPTION:                                          │
│  1. Override console.error / console.warn               │
│  2. window.onerror handler                              │
│  3. window.onunhandledrejection                         │
├─────────────────────────────────────────────────────────┤
│  ENRICHMENT:                                            │
│  1. Parse stack trace                                   │
│  2. Map to source via sourcemaps                        │
│  3. Capture context (variables, props)                  │
│  4. Detect common error patterns                        │
├─────────────────────────────────────────────────────────┤
│  STORAGE:                                               │
│  1. Circular buffer (last N errors)                     │
│  2. Deduplication (same error = increment count)        │
│  3. Timestamp and session                               │
├─────────────────────────────────────────────────────────┤
│  OUTPUT:                                                │
│  1. Popup with error list                               │
│  2. Formatted export for LLM                            │
│  3. Integration with SvelteGrab                         │
└─────────────────────────────────────────────────────────┘
```

### Feasibility

| Aspect | Assessment | Notes |
|--------|------------|-------|
| Console intercept | ✅ Feasible | Native APIs |
| Stack parsing | ✅ Feasible | Error.stack |
| Source maps | ✅ Feasible | Already supported in browsers |
| Variable context | ⚠️ Partial | Limited without instrumentation |
| Pattern detection | ✅ Feasible | Regex + heuristics |

**Technical Challenges:**
1. Capturing variables at the time of error is difficult
2. Source maps are not always available
3. Errors in third-party code (libs)
4. Interception overhead

**Possible Solutions:**
1. For context, use last known snapshot
2. Fallback to original stack trace if no sourcemap
3. Filter errors from node_modules
4. Throttling of repeated errors

### Implementation Plan

#### Phase 1: Basic Intercept (1 week)
- [ ] Override console.error/warn
- [ ] Capture window.onerror
- [ ] Circular error buffer

#### Phase 2: Stack Parsing (1 week)
- [ ] Stack trace parser (Chrome, Firefox, Safari)
- [ ] Source map integration
- [ ] Map to Svelte files

#### Phase 3: Context (2 weeks)
- [ ] Capture component props at error time
- [ ] Detect common error patterns
- [ ] Generate fix suggestions

#### Phase 4: UI & Export (1 week)
- [ ] Visualization popup
- [ ] Severity filters
- [ ] Formatted export for LLM
- [ ] Integration with SvelteGrab

### Total Estimate: 5-6 weeks

---

## Tool 6: Svelte-Render-Profiler

### Description

Monitors and reports component re-renders, identifying excessive renders and their causes (props changes, state changes, context updates).

### Problem It Solves

Performance issues are invisible:
- Components re-rendering unnecessarily
- Props changing reference on every render
- Effects cascading updates
- Memory leaks from subscriptions

### Example Output

```
=== Render Profile: last 10 seconds ===

🔴 HOT COMPONENTS (excessive re-renders):

  1. <ProductCard> - 147 renders
     │ 📍 src/lib/ProductCard.svelte
     │
     │ 🔍 CAUSE:
     │    Prop 'product' changes reference on every parent render
     │
     │    Parent (<ProductList>) does:
     │    {#each products as product}
     │      <ProductCard product={{ ...product, selected: isSelected(product.id) }} />
     │                   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
     │                   New object created on every render!
     │
     │ ✅ SOLUTION:
     │    Move 'selected' logic inside ProductCard
     │    Or use $derived to memoize the object

  2. <SearchResults> - 89 renders
     │ 📍 src/lib/SearchResults.svelte
     │
     │ 🔍 CAUSE:
     │    $effect without correct dependencies
     │    Re-executes on any state change
     │
     │ ✅ SOLUTION:
     │    Specify explicit dependencies

🟢 HEALTHY COMPONENTS:

  <Header> - 2 renders ✓
  <Footer> - 1 render ✓
  <Sidebar> - 5 renders ✓

📊 TIMELINE:

  00:00 ─────────────────────────────── 00:10
        ╭─ ProductCard (burst: 50 renders)
        │  │ Trigger: products store update
        │  ╰─ Cause: each item re-created
        │
        ╰─ SearchResults (burst: 30 renders)
           │ Trigger: input debounce fail
           ╰─ Cause: effect re-running
```

### How It Works Technically

```
┌─────────────────────────────────────────────────────────┐
│                 Svelte-Render-Profiler                   │
├─────────────────────────────────────────────────────────┤
│  INSTRUMENTATION (Compile-time):                        │
│  1. Vite plugin injects tracking code                   │
│  2. Each component reports mount/update/destroy          │
│  3. Captures props/state diff on each update             │
├─────────────────────────────────────────────────────────┤
│  RUNTIME:                                               │
│  1. Central collector receives events                    │
│  2. Groups by component                                  │
│  3. Detects bursts (many renders in short time)          │
│  4. Analyzes causes (which prop/state changed)           │
├─────────────────────────────────────────────────────────┤
│  ANALYSIS:                                              │
│  1. Identifies problematic patterns                      │
│  2. Correlates with source code                          │
│  3. Generates optimization suggestions                   │
└─────────────────────────────────────────────────────────┘
```

### Feasibility

| Aspect | Assessment | Notes |
|--------|------------|-------|
| Render tracking | ⚠️ Complex | Requires instrumentation |
| Props diff | ✅ Feasible | Shallow compare |
| Burst detection | ✅ Feasible | Statistics |
| Cause analysis | ⚠️ Partial | Heuristics |
| Timeline | ✅ Feasible | Event buffer |

**Technical Challenges:**
1. Instrumentation adds overhead
2. Svelte 5 has a different reactive model
3. Differentiating "good" renders from "bad" ones
4. Large volume of data to process

**Possible Solutions:**
1. Sampling instead of full tracking
2. Only marked components (@profile)
3. Post-hoc analysis instead of real-time
4. Integration with Svelte DevTools

### Implementation Plan

#### Phase 1: Basic Tracking (2 weeks)
- [ ] Vite plugin for instrumentation
- [ ] Render counter per component
- [ ] Basic visualization UI

#### Phase 2: Cause Analysis (3 weeks)
- [ ] Detect which prop/state changed
- [ ] Identify referential inequality
- [ ] Correlate with code

#### Phase 3: Recommendations (2 weeks)
- [ ] Known problem patterns
- [ ] Fix suggestions
- [ ] Example fix code

#### Phase 4: Timeline (1 week)
- [ ] Temporal visualization
- [ ] Event correlation
- [ ] Profile export

### Total Estimate: 8-10 weeks

---

## Prioritization Matrix

| Tool | Impact | Complexity | Time | ROI | Priority |
|------|--------|------------|------|-----|----------|
| Svelte-State-Grab | 🔴 High | 🟡 Medium | 5-8 wks | High | **#1** |
| Svelte-Error-Context | 🔴 High | 🟢 Low | 5-6 wks | Very High | **#2** |
| Svelte-A11y-Reporter | 🟡 Medium | 🟡 Medium | 7-8 wks | Medium | **#3** |
| Svelte-Style-Grab | 🟡 Medium | 🔴 High | 6-7 wks | Medium | **#4** |
| Svelte-Render-Profiler | 🟡 Medium | 🔴 High | 8-10 wks | Low | **#5** |
| Svelte-Props-Tracer | 🔴 High | 🔴 High | 8-10 wks | Medium | **#6** |

---

## Suggested Roadmap

### Phase 1: Quick Wins (Month 1-2)
```
Week 1-6:  Svelte-Error-Context
           └─ High impact, low complexity
           └─ Complements SvelteGrab immediately

Week 5-8:  Svelte-State-Grab (parallel start)
           └─ MVP can be a SvelteGrab feature
```

### Phase 2: Core Tools (Month 3-4)
```
Week 9-16: Svelte-State-Grab (complete)
           └─ Deep integration with SvelteGrab

Week 12-18: Svelte-A11y-Reporter
            └─ Can start in parallel
```

### Phase 3: Advanced (Month 5-6)
```
Week 19-25: Svelte-Style-Grab
            └─ Requires more CSS internals research

Week 22-28: Decision: Props-Tracer or Render-Profiler
            └─ Based on user feedback
```

### Phase 4: Suite Integration (Month 7)
```
Week 29-32: Unification of tools
            └─ Shared UI
            └─ Combined export for LLMs
            └─ Complete documentation
```

---

## Proposed Unified Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                        Svelte DevKit                            │
│                    (suggested suite name)                        │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐               │
│  │ SvelteGrab  │ │ StateGrab   │ │ StyleGrab   │               │
│  │ (location)  │ │ (state)     │ │ (css)       │               │
│  └──────┬──────┘ └──────┬──────┘ └──────┬──────┘               │
│         │               │               │                       │
│  ┌──────┴───────────────┴───────────────┴──────┐               │
│  │              Core Engine                     │               │
│  │  - Element selection                        │               │
│  │  - __svelte_meta access                     │               │
│  │  - Clipboard management                     │               │
│  │  - UI components                            │               │
│  └──────┬───────────────┬───────────────┬──────┘               │
│         │               │               │                       │
│  ┌──────┴──────┐ ┌──────┴──────┐ ┌──────┴──────┐               │
│  │ ErrorCtx    │ │ A11yReport  │ │ RenderProf  │               │
│  │ (errors)    │ │ (a11y)      │ │ (perf)      │               │
│  └─────────────┘ └─────────────┘ └─────────────┘               │
│                                                                 │
├────────────────────────────────────────────────────────────────┤
│                      LLM Export Layer                           │
│  - Unified format optimized for context                        │
│  - Prioritization of relevant information                      │
│  - Token-efficient formatting                                  │
└────────────────────────────────────────────────────────────────┘
```

---

## Next Steps

1. **Validate prioritization** with SvelteGrab user feedback
2. **Start Svelte-Error-Context** as the next project
3. **Prototype State-Grab** as an additional feature of SvelteGrab
4. **Define the suite name** (Svelte DevKit? Svelte AI Tools?)
5. **Create a monorepo** for all the tools

---

## Appendix: Technical Considerations

### Svelte 5 vs Svelte 4

| Feature | Svelte 4 | Svelte 5 |
|---------|----------|----------|
| State access | `$$props`, `$$restProps` | `$props()` rune |
| Reactivity | `$:` statements | `$state`, `$derived` |
| Effects | `$:` | `$effect` |
| Internals | More exposed | More encapsulated |

Svelte 5 is more "closed" by design, which makes some tools more challenging. It may be necessary to:
- Submit feature requests to the Svelte team
- Request official development hooks
- Collaborate with Svelte DevTools

### Performance Budget

For dev tools, acceptable:
- Capture latency: < 100ms
- Runtime overhead: < 5% CPU
- Memory: < 10MB additional
- Bundle size: Lazy load, < 50kb initial

### Compatibility

- Browsers: Chrome 90+, Firefox 88+, Safari 14+
- Svelte: 5.x (primary), 4.x (best effort)
- SvelteKit: 2.x
- Vite: 5.x+
