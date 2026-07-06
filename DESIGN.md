---
name: CodeRadius Dashboard
description: Architecture intelligence dashboard for polyglot codebases
colors:
  canvas: "#0F1014"
  rail: "#131419"
  strip: "#16181D"
  overlay: "#1B1E24"
  hover: "#1F232A"
  line-primary: "#232830"
  line-strong: "#2A3038"
  line-dim: "#1B1F26"
  ink-primary: "#ECEEF1"
  ink-secondary: "#B5BCC4"
  ink-tertiary: "#7A848D"
  ink-muted: "#525B64"
  ink-faint: "#3C434C"
  signal: "#14B8A6"
  danger: "#F04A5C"
  warn: "#F2B445"
  ok: "#3CC58E"
typography:
  display:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "32px"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  h1:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.2
  h2:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  caption:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
  micro:
    fontFamily: "JetBrains Mono, Menlo, ui-monospace, monospace"
    fontSize: "10.5px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "0.08em"
    textTransform: "uppercase"
  mono:
    fontFamily: "JetBrains Mono, Menlo, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
rounded:
  sm: "4px"
  md: "5px"
  lg: "6px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "40px"
  page-gutter: "16px"
components:
  topbar:
    backgroundColor: "{colors.rail}"
    height: "44px"
    padding: "0 16px"
  identity-strip:
    backgroundColor: "{colors.strip}"
    padding: "14px 16px"
  statusbar:
    backgroundColor: "{colors.rail}"
    height: "24px"
    padding: "0 16px"
  toggle-group:
    backgroundColor: "{colors.overlay}"
    rounded: "{rounded.lg}"
    padding: "2px"
  toggle-group-active:
    backgroundColor: "{colors.strip}"
  input-search:
    backgroundColor: "{colors.overlay}"
    rounded: "{rounded.md}"
    height: "28px"
  button-export:
    backgroundColor: "{colors.overlay}"
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.md}"
    height: "28px"
  button-export-hover:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.ink-primary}"
  table-header:
    backgroundColor: "{colors.strip}"
    height: "34px"
  table-cell:
    padding: "12px 14px"
  table-row-hover:
    backgroundColor: "{colors.hover}"
  tooltip:
    backgroundColor: "#F0F0F0"
    textColor: "#1A1A1A"
    rounded: "8px"
    padding: "6px 12px"
---

# Design System: CodeRadius Dashboard

## 1. Overview

**The Quiet Operator.** Restrained until something matters, then precise in exactly the right place.

CodeRadius is an engineering intelligence tool that a platform engineer keeps open all day and a CTO opens twice on a Tuesday. The visual posture respects both. Dark surface, one technical accent (signal teal), personality through signature visuals (blast gauge, tier glyphs, segmented adoption bars).

90% of the UI is ink-0 through ink-3 on bg-0 through bg-2. Signal teal appears for selection and the active section only. State colors (danger, warn, ok) appear only when there is actual state to communicate.

**Anti-references:** Datadog's visual density (patterns are good, finish is not). Marketing SaaS dashboards with gradient cards and hero metrics. Splunk's visual noise.

**References:** Vercel's dashboard discipline. Linear's geometric clarity. Stripe's data-density confidence.

## 2. Colors: The Quiet Operator Palette

Five surface tones create depth without decoration:

| Token | Hex | Role |
|-------|-----|------|
| canvas | `#0F1014` | Page background, table body |
| rail | `#131419` | Sidebar, topbar, statusbar |
| strip | `#16181D` | Identity strips, table headers |
| overlay | `#1B1E24` | Inputs, toggle groups, elevated panels |
| hover | `#1F232A` | Hover states, active backgrounds |

Two line weights for structure:

| Token | Hex | Role |
|-------|-----|------|
| line-primary | `#232830` | Section borders, row dividers |
| line-strong | `#2A3038` | Stronger borders on focus |
| line-dim | `#1B1F26` | Subtle row dividers within tables |

Four ink tones for text hierarchy:

| Token | Hex | Role |
|-------|-----|------|
| ink-primary | `#ECEEF1` | Primary text, names, numbers |
| ink-secondary | `#B5BCC4` | Secondary text, descriptions |
| ink-tertiary | `#7A848D` | Labels, meta text |
| ink-muted | `#525B64` | Disabled, placeholder, muted tier |

Four state colors, used only when there is state:

| Token | Hex | Role |
|-------|-----|------|
| signal | `#14B8A6` | Selection, active tab, focus ring |
| danger | `#F04A5C` | T0 Seismic, major drift, CVE critical/high |
| warn | `#F2B445` | T1 Critical, minor drift, medium CVE |
| ok | `#3CC58E` | Aligned, healthy, contracts depth |

**Node type colors** (taxonomy): Service `#a78bfa`, Library `#c084fc`, DataContainer `#60a5fa`, Datastore `#818cf8`, MessageChannel `#f59e0b`, APIEndpoint `#22d3ee`, Package `#4ade80`, SystemProcess `#f472b6`.

## 3. Typography

Two families. Inter for everything human-readable. JetBrains Mono for everything machine-readable.

| Role | Family | Size | Weight | Tracking |
|------|--------|------|--------|----------|
| Display | Inter | 32px | 600 | -0.02em |
| H1 | Inter | 22px | 600 | 0 |
| H2 / Identity title | Inter | 15px | 600 | -0.005em |
| Body | Inter | 14px | 400 | 0 |
| Caption | Inter | 12px | 400 | 0 |
| Table header | JetBrains Mono | 9.5px | 600 | 0.14em, uppercase |
| Micro label | JetBrains Mono | 10.5px | 500 | 0.08em, uppercase |
| KPI number | Inter | 18px | 600 | -0.01em, tabular-nums |
| Mono data | JetBrains Mono | 12px | 400 | 0 |

Display size (32px) is reserved for marketing only. Product surfaces cap at H1 (22px). Headings at 22px and above use negative tracking; body and below use natural tracking.

## 4. Elevation

Flat. No box-shadows on surfaces. Depth is communicated through background-color tiers (canvas < rail < strip < overlay < hover), not shadows.

The only shadow in the system is on the tooltip (`0 4px 14px rgba(0,0,0,0.35)`) and modal (`0 24px 48px rgba(0,0,0,0.5)`). Both are functional (floating above the page), not decorative.

## 5. Components

**PageTopBar**: 44px rail-colored strip at the top. Title left, actions right. No backdrop blur.

### Page shell (`cr-page-*`)

Shared structural classes used by all operator pages (System Registry, Package Intelligence, Gravity, Agent Harness). Defined in `registry.css`.

- **`cr-page-shell`**: grid layout (identity / tabs / body / statusbar). Bleeds past container padding for edge-to-edge backgrounds via `margin-inline: calc(var(--page-padding-x) * -1)` + `width: calc(100% + var(--page-padding-x) * 2)`.
- **`cr-page-identity`**: strip-colored bar. Icon + title + subtitle left (`__copy`, `__mark`), KPI metrics right (`cr-page-kpis`). 14px/16px padding. `align-items: center`.
- **`cr-page-kpis`** / **`cr-page-kpi`**: flex row of KPI readouts. Each KPI: `__num` (18px semibold tabular-nums) + `__label` (10px mono uppercase). Tones: `--danger`, `--warn`, `--ok`, `--signal`, `--internal`. Separator: `cr-page-kpi-sep` (1px vertical line).
- **`cr-page-tabs-strip`**: grid (tabs left, actions right). 44px height, rail background, bottom border. Tab underline color via `--cr-page-tab-accent` custom property (default: `#a78bfa`).
- **`cr-page-tabs`**: flex nav with 20px gap. Scrollable, hidden scrollbar.
- **`cr-page-tab`**: 12.5px, medium weight. Active: ink-0 + `::after` 2px underline. No weight change on active.
- **`cr-page-tab__count`**: mono 10px pill (bg-2, 4px radius).
- **`cr-page-actions`**: flex row for filter controls + action buttons. `padding-bottom: 8px`.
- **`cr-page-body`**: scrollable content area. `overflow: hidden`, bg-0.

Page-specific overrides go on the page wrapper (e.g., `--cr-page-tab-accent: #4ade80` on Package Intelligence for green tab underline).

### CrPill (`cr-pill`)

Colored status/value pill. Mono 9.5px, 500 weight, 3px radius. Defined in `design-system.css`. Used for skill status badges, similarity percentages, and any inline categorical label.

Tones: `--signal` (blue, bordered), `--warn` (yellow), `--danger` (red), `--ok` (green), `--muted` (ink-1, line border), `--outline` (transparent bg, currentColor border).

**StatusBar**: 24px rail-colored strip at the bottom. Sticky. Version, timestamp, LOCAL dot left. Page-specific state right. Mono 10px uppercase.

**ToggleGroup**: Segmented pill control. overlay background, strip active pill with subtle shadow. Used for Graph/List toggle and direction filter.

**OperatorTable**: Dense data table with sticky strip-colored header. Borderless inputs. Sort on header click. Row hover at bg-3. First/last cell padding 16px. Group headers: mono 10px, ink-3, muted section separators. Expanded rows animate via `grid-template-rows: 0fr/1fr` with content fade-in.

**OperatorFilter**: Borderless search input (overlay bg) with prefix-scoped filtering via TaggedSearch. Scope tags activate column-specific filters with value chip dropdowns.

**TierGlyphBadge**: Grade + label with geometric glyph (triangle T0, square T1, dot T2, dash T3). Badge variant (filled) for banners, minimal variant (text-colored) for table cells.

**SegmentedBar**: Continuous proportional bar for adoption health. Rounded ends. Segments touch edge-to-edge, colored by drift tier.

**BarredProgress**: Discrete segmented bar for activity/liveness. Used in System Registry.

**ConsumerBar**: Discrete bar (4px segments, signal color) + fraction label. Used in Skill Library for adoption ratio.

**Tooltip**: Light background (#F0F0F0), dark text (#1A1A1A), 8px radius. Google-style. Radix Arrow for positioning. 120ms delay.

**CVE Badge**: Clickable pill linking to OSV.dev. Mono font, tinted background (`color-mix` 12% of `currentColor`). Severity maps to the state vocabulary: critical = danger, high = `#f87171`, medium = warn, low/unknown = muted rose `#c9939b` (never ink/grey: a vulnerability is never neutral). Labels sort worst-first so the visible slice shows the most severe. The overflow counter (+N) inherits the worst hidden severity; its tooltip shows the severity distribution ("2 critical, 9 high"), never the raw id list. Clicking it expands the row directly on the Vulnerabilities view: the expanded row is segmented (Consumers / Versions / Vulnerabilities · N via ToggleGroup), so the full advisory list (severity as text, id, summary, OSV link) never stacks under dozens of consumer rows.

## 6. Do's and Don'ts

**Do:**
- Use the 5-tone surface scale for depth. Canvas for content, rail for chrome, strip for headers.
- Keep state colors for actual state. Green means "verified" or "aligned", never decoration.
- Use mono font for all machine-readable data: versions, URNs, commit hashes, counts.
- Keep inputs borderless. Background color change on focus is sufficient affordance.
- Use the PageIdentityStrip for every page's header area. Consistent layout across all surfaces.

**Don't:**
- Add borders to inputs, toggles, or buttons. Borderless with background tiers.
- Use em dashes in any UI text. Commas, colons, or semicolons.
- Use `cursor: help` on tooltip-bearing elements. Default cursor only.
- Add side-stripe borders (left/right accent borders) on cards or list items.
- Show gradient text, glassmorphism, or decorative shadows.
- Duplicate the page title between the topbar and the identity strip.
- Use the display type scale (32px) in product surfaces.
