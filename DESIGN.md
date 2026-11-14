# DESIGN.md — Tender Consolidated Market Tape & Clearinghouse Terminal

## Design Read

**"Reading this as: institutional market-tape & live sealed-bid clearinghouse terminal for AI agent operators, protocol engineers, and hackathon judges, with a Swiss-precision operational financial language (FINRA TRACE / Linear / Bloomberg B-PIPE), leaning toward Tailwind v4 CSS-variable semantic tokens + Geist Sans & Geist Mono (`tabular-nums`) + `@phosphor-icons/react` + restrained state-driven motion."**

- **Dials**: `DESIGN_VARIANCE: 5` | `MOTION_INTENSITY: 4` | `VISUAL_DENSITY: 8` (Operational Market Tape — crisp `1px` hairlines, zero decorative bloat, high scannability).
- **Five-Second First-Viewport Comprehension**: Within 5 seconds of opening Tender at `1440x900` or `375x812`, a visitor immediately grasps:
  1. **What Tender is**: The first live public price index and sealed-bid clearinghouse for AI labor on NEAR Protocol.
  2. **What AI labor costs right now**: Live consolidated benchmark strip (Median Clearing Price, Competitive Bid Spread, Buyer Vickrey Savings, Settled Prints) — or an honest `"Awaiting first settled print"` empty state when `count === 0`.
  3. **How sealed-bid clearing works & how to execute**: Live 5-stage Commit → Reveal → Vickrey Clear → Deliver → Settle pipeline with one-click auction creation and WebCrypto `tender:v1` sealed bidding.

---

## Palette & Semantic CSS Tokens (Light Default + Dark Mode Parity)

No AI-purple glows, no warm-craft beige/brass clichés, no pure `#000000` or `#FFFFFF` page backgrounds. One locked accent family (**Clearing Emerald**) across the entire product, with semantic phase indicators strictly reserved for auction state pills.

| Token | Light Mode (`:root`) | Dark Mode (`[data-theme="dark"]`) | Purpose & Contrast Check |
|---|---|---|---|
| `--bg-canvas` | `#F3F5F7` | `#0B0E13` | Root viewport surface (cool architectural zinc-slate) |
| `--bg-surface` | `#FAFBFC` | `#121720` | Primary workspace & table container |
| `--bg-elevated` | `#EDF0F4` | `#19202C` | Interactive control wells, code/hash blocks, active row hover |
| `--border-hairline` | `#D5DCE4` | `#263040` | `1px` structural grid dividers & table rules |
| `--border-strong` | `#9AA6B5` | `#3E4C63` | Input borders (WCAG AA non-text contrast) & active panels |
| `--text-primary` | `#0F141B` | `#F1F5F9` | Headlines, prices, primary labels (`> 14:1` contrast) |
| `--text-secondary` | `#3E4C5E` | `#94A3B8` | Table metadata, form labels, helper text (`> 7:1` contrast) |
| `--text-muted` | `#5B6B7F` | `#78879B` | Timestamps, receipt hashes (`>= 4.6:1` WCAG AA) |
| `--accent-primary` | `#047857` | `#10B981` | Primary CTA fill / active clearing accent (`#F8FAFC` text on `#047857` = `5.4:1` AA) |
| `--accent-subtle` | `#DCFCE7` | `#064E3B` | Settled badge surface & Vickrey surplus highlight |
| `--status-commit` | `#1D4ED8` | `#60A5FA` | `CommitOpen` sealed phase indicator |
| `--status-reveal` | `#B45309` | `#FBBF24` | `RevealOpen` cryptographic reveal phase indicator |
| `--status-danger` | `#B91C1C` | `#F87171` | Inline validation errors, failed payouts, disputed state |

---

## Typography & Numeric Precision

- **UI Sans**: `Geist` (`@fontsource-variable/geist` self-hosted bundle, fallback `system-ui, -apple-system, sans-serif`) — clean geometric neo-grotesk, zero external Google Fonts `<link>` requests.
- **Data & Cryptographic Mono**: `Geist Mono` (`@fontsource-variable/geist-mono` self-hosted bundle, fallback `ui-monospace, SFMono-Regular, monospace`) with `font-variant-numeric: tabular-nums slashed-zero` enforced on every price, spread, basis-point metric, countdown, block height, and SHA-256 hash.
- **Scale**:
  - Top bar brand + network status: `14px` medium (`h-14` = `56px` single-line header).
  - Compact Mission & Benchmark Header: `28px`/`34px` (`md:text-3xl`) tight headline (`max 2 lines`), subtext `<= 18 words`, paired directly with the 4-cell Consolidated Index Strip above the fold.
  - Table headers & metric labels: `11px` mono uppercase (`letter-spacing: 0.06em`) — strictly inside data grid column headers, respecting eyebrow restraint (`<= 1` section eyebrow per 3 sections).
  - Body / Form labels: `14px` (`0.875rem`) label explicitly ABOVE every input (`gap-1.5`), helper/error text BELOW input. Never placeholder-as-label.

---

## Layout Architecture & Responsive Contract (`375px` → `1440px`)

1. **Single-Line Operational Top Bar (`56px`)**:
   - Left: Tender geometric mark + wordmark + live network badge (`NEAR Testnet` / `Local Sandbox` + contract account ID + synced block height).
   - Right: Theme toggle (`Light` / `Dark`), Sync/Refresh trigger, and primary CTA **`Post Escrowed Job`** (single consistent CTA label across page).
2. **Above-the-Fold Split Header + Consolidated Index Strip**:
   - Left (`7 cols` desktop, full-width `375px`): Crisp 2-line statement explaining Tender + interactive 5-step Clearing Lifecycle rail (`1. Escrow Job` → `2. Sealed Commit` → `3. Hash Reveal` → `4. Vickrey Clear` → `5. Deliver & Print`).
   - Right / Full-width Strip: 4 hairline-divided live index cells sourced exclusively from `/tape/median` and `/tape/spread`:
     - **Median Clearing Price** (`NEAR` + exact yocto tooltip, or `"Awaiting print"`)
     - **Median Unit Rate** (`NEAR / unit`)
     - **Competitive Spread** (`runner_up - winning_bid` bps)
     - **Buyer Vickrey Savings** (`reserve - clearing` bps)
3. **Primary Two-Zone Operational Workspace (`12-col` desktop → stacked single-column `< 1024px`)**:
   - **Left/Main Zone (`8 cols`) — Consolidated Market Tape & Analytics**:
     - Category filter pills (`All`, `smart-contract-audit`, `code-generation`, `data-labeling`, `research-synthesis`, etc.) + Mechanism filter (`All`, `Vickrey 2nd-Price`, `First-Price`).
     - **Live Consolidated Tape**: Chronological settled prints showing `Print # / Job ID`, `Category & Work Units`, `Clearing Price`, `Winning Bid vs Runner-Up`, `Unit Price`, `Mechanism`, `Winner`, and expandable cryptographic proof (`spec_sha256`, `deliverable_sha256`, `receipt_id`). On `375px` mobile, renders as structured stacked tape cards with zero horizontal page overflow (`scrollWidth <= innerWidth`).
     - **Analytics Sub-Panels**: Category Median Breakdown (`/tape/median`) + Worker Agent Win-Rate & Reveal Reliability Table (`/tape/win-rate`).
   - **Right/Action Zone (`4 cols`) — Live Sealed-Bid Clearinghouse Desk**:
     - Active Auctions list (`/jobs`) showing current phase (`CommitOpen`, `RevealOpen`, `Assigned`, `Delivered`, `Settled`) and live phase window status.
     - Contextual Lifecycle Workbench for the selected job:
       - **Create Job**: Buyer sets category, objective `work_units` + `unit_label`, `reserve_price`, `mechanism` (`Vickrey` default / `FirstPrice`), commit/reveal/delivery durations, and `spec_sha256` (auto-hashed in WebCrypto from job prompt/spec).
       - **Commit Sealed Bid (`0 NEAR` Function-Call Key safe)**: Worker selects/connects account, enters secret `bid_near` + `eta_seconds`, auto-generates random 16-byte hex `salt` in WebCrypto (`localStorage` salt vault keyed by `contract:job:worker`), previews exact `tender:v1:...` SHA-256 commitment hash, and submits `commit_bid`.
       - **Reveal Bid**: Loads saved `(bid_yocto, eta_seconds, salt)` from browser vault (or manual JSON paste) and calls `reveal_bid`.
       - **Clear Auction**: Calls `finalize_auction`, displaying winner, runner-up bid, and computed Vickrey clearing price + buyer surplus.
       - **Deliver & Settle**: Winner submits `deliverable_uri` + WebCrypto `deliverable_sha256`; Buyer calls `accept_delivery` (or worker triggers `finalize_after_timeout` once dispute window expires), immediately printing to the Consolidated Tape.

---

## Anti-Slop & Accessibility Hard Rules

- **Zero Fabricated Numbers**: Never render mock prices, fake volume, or synthetic agent names in production code. Empty states clearly guide the user to run or post an auction.
- **Shape Consistency Lock**: `6px` (`rounded-md`) radius across all panels, inputs, and buttons; `4px` (`rounded`) on inline status badges. No mixed pill/brutalist collisions.
- **Iconography**: `@phosphor-icons/react` exclusively (`weight="regular"` / `weight="bold"`, consistent sizing). Zero emojis in UI markup.
- **Motion & Accessibility**: Transform/opacity transitions only (`150ms–220ms cubic-bezier(0.16, 1, 0.3, 1)`), full `@media (prefers-reduced-motion: reduce)` collapse, semantic `<main>`, `<nav>`, `<section>`, `<table>`, `<dialog>`/`aria-live="polite"` tape updates, and high-visibility `2px` `:focus-visible` outlines on every interactive element.
