# Neuralyn visual system — usage notes

Neuralyn is a compact, analytical workspace UI. The reference is precision
software (Linear's density, Vercel's restraint), **not** a marketing site. Every
screen should read as an instrument: quiet surfaces, sharp data, one accent.

## Non-negotiables

- Dark-first. `:root` ships the dark palette; `html.light` swaps in the light
  palette, `html.dark` is the explicit dark class. Theme changes must also reach
  charts, tooltips and overlays (all tokens below are semantic).
- Pure-black dark canvas, hairline borders, small radii (6–8 px), 4 px spacing
  rhythm. No large rounded cards, no glassmorphism, no coloured section blocks.
- Type: **Inter** 400/500/600/700 for everything operational. **Instrument
  Serif** italic only as an occasional editorial accent, never for branding or
  navigation. The wordmark is Inter 700 at 18–20 px. Numbers always use `.tabular`.
- Motion is short (120–240 ms) and only for navigation, page entry, toasts and
  overlays. Everything is disabled under `prefers-reduced-motion`.
- All controls do something. No marketing copy, no dead buttons, no fake remote
  success states. Demo data is local: label it as such, never imply production.

## Layout

| Element | Size |
| --- | --- |
| Sidebar | 240 px expanded / 64 px collapsed |
| Top bar | 64 px |
| Content max width | 1440 px, 24–32 px gutter |
| Grid gap | 16 px (dense) / 24 px (section) |
| Radius | `rounded-md` = 6 px; pills only for status/tiny labels |

The shell owns scrolling: body is locked, top bar is fixed in the flex column,
and the page area scrolls. Never create a second page-level scroll container.

## Tokens (HSL channel triplets, use as `hsl(var(--token))`)

Core: `--background --foreground --card --card-foreground --popover
--popover-foreground --primary --primary-foreground --secondary
--secondary-foreground --muted --muted-foreground --accent --accent-foreground
--destructive --destructive-foreground --border --input --ring --radius`.

Surfaces / data: `--surface --surface-raised --hairline --positive --warning
--info --chart-1 … --chart-6 --chart-grid --chart-axis`.

Semantic status colours: success = `--positive`, pending = `--warning`,
failed = `--destructive`, neutral = `--muted-foreground`.

The palette is monochromatic: `--primary` is near-white in dark mode and
near-black in light mode. Active navigation uses low-contrast gray surfaces.
Reserve subdued semantic colours for status; chart 2 may be blue-gray.
Dark surfaces use black canvas, 5% card, 3% sidebar, 8% raised surface, 10%
hover and 12% active. Borders are 17%, hairlines 11%, muted text 60%, and
secondary text 75%; the primary foreground pair is 98% / 5%.

## Shared classes (global, safe for every lane)

- `.page` — 1440 px capped page container with responsive gutters.
- `.panel` — bordered instrument surface; `.panel-header`, `.panel-body`,
  `.panel-title`, `.panel-kicker`.
- `.filterbar` — dense toolbar row with wrap and 8 px gap.
- `.segmented` + `.segmented-item[aria-pressed="true"]` — small mode switches.
- `.data-table` — semantic table styling (header, row hover, numeric cells).
- `.field`, `.field-label`, `.field-hint` — form rhythm.
- `.eyebrow` — 11 px uppercase tracking; `.serif` — Instrument Serif italic.
- `.tabular` — tabular figures for every metric/time cell.
- `.skeleton` — reduced-motion-aware loading block.
- `[data-density="compact"]` — store-driven tighter page, panel, metric and table spacing.
- `.scroll-thin` — thin themed scrollbars for inner scroll areas.
- `.focus-ring` and the global `:focus-visible` style — keyboard affordance.

Prefer Tailwind utilities for one-off spacing/layout; reach for these classes
for repeated instrument chrome.

## Components (contracts are frozen)

- `common/PageHeader.vue` — `title`, `description`, `actions` slot. Use once per page.
- `common/EmptyState.vue` — `title`, `description`, default slot for one action.
- `common/StatusBadge.vue` — `status` string; auto-maps Completed/Active/Pending/Failed/Invited and goal states.
- `common/DateRangePicker.vue` — reads/writes the shared preference `period`; do not create a second period state.
- `charts/BaseChart.vue` — `option`, `height` (280), `ariaLabel`; modules registered once, autoresize, theme tokens, reduced motion, screen-reader summary. All charts go through it.
- `dashboard/MetricCard.vue` — `label`, `value`, `change`, `comparison?`, `sparkline?`.
- `dashboard/ActivityTable.vue` — `events`, `title?` (optional `loading?`); owns search/filter/sort/pagination/selection/details. Do not re-implement the table in another lane.

Panels: a titled section is `.panel` with a `.panel-header`; charts sit directly
in `.panel-body` with no extra card padding. Metrics use MetricCard, never a
bespoke stat card. Filters live in `.filterbar` above the content they affect.

## Charts

Use ECharts through BaseChart only. Current data is `--chart-1` (soft white in dark mode) with a
subtle area fill; comparison data is a dashed muted line. Grid lines are
`--chart-grid`, labels `--chart-axis`. Tooltips use `--popover`, hairline border
and tabular values. Every chart needs an `ariaLabel` that states what is shown
and its range. Donut legends are interactive (hover highlight, click toggle) and
must not rely on colour alone — show name, value and percent.

## Interaction conventions

- Global command palette: `⌘K` / `Ctrl K`, arrows move, Enter selects, Esc closes.
- Page titles are breadcrumbed as `Workspace / Page` in the top bar.
- Destructive local actions require confirmation or a clear, reversible toast.
- Empty tables explain the filter that emptied them and offer reset.
- Toasts appear bottom-right in a polite live region and auto-dismiss.
- Mobile navigation is a Reka focus-managed drawer; route changes close it.
- Workspace and theme are visible state: switching either updates all data,
  labels, charts and tooltips without a reload.
