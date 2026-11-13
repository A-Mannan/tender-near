# Spec Delta

## Purpose

Defines the Consolidated Market Tape & Sealed-Bid Clearinghouse web terminal, ensuring immediate 5-second comprehension, zero fabricated data, end-to-end sealed-bid execution, responsive layout (`375px`–`1440px`), and keyboard/contrast accessibility.

## ADDED Requirements

### Requirement: Five-second first-viewport comprehension and real data integrity
The first viewport MUST communicate ClearTape as the public price index of AI labor alongside the live 5-stage sealed-bid clearing lifecycle, rendering exclusively real contract/indexer values with explicit loading, empty, and error states and zero hardcoded price numbers.

#### Scenario: Fresh deployment with zero settled prints
- **WHEN** the UI loads against a newly deployed contract and empty indexer database
- **THEN** the benchmark strip and tape display explicit `"Awaiting first settled print"` empty states rather than placeholder numbers

#### Scenario: Live update after on-chain settlement
- **WHEN** a job settles on the NEAR contract and is indexed
- **THEN** the consolidated tape, category median, competitive spread, and worker win-rate views reflect the exact settled values without page reload or hardcoded fallbacks

### Requirement: Browser-driven sealed-bid lifecycle execution
The UI MUST allow users/agents to create an escrowed job, compute a domain-separated `cleartape:v1` SHA-256 bid commitment in browser WebCrypto (retaining the secret salt locally until reveal), submit commits, reveal bids, finalize clearing, submit SHA-256 deliverables, and settle payouts.

#### Scenario: Full lifecycle driven through browser UI
- **WHEN** a user creates a job, commits two sealed worker bids, advances to reveal, reveals both bids, clears the auction, submits delivery, and accepts delivery via UI controls
- **THEN** each phase updates on-chain contract state and produces a verified print on the live consolidated tape

### Requirement: Responsive geometry and WCAG AA keyboard accessibility
The interface MUST render without horizontal overflow or clipped controls from `375px` mobile width to `1440px` desktop width, meet WCAG AA color contrast (`>= 4.5:1` body text), and provide visible `:focus-visible` keyboard navigation across all interactive controls.

#### Scenario: Playwright audit at 375px and 1440px
- **WHEN** automated E2E tests inspect layout geometry, keyboard tab order, and contrast at `375x812` and `1440x900`
- **THEN** `document.documentElement.scrollWidth <= window.innerWidth`, every interactive element is keyboard reachable with visible focus styling, and no overlapping or clipped text occurs
