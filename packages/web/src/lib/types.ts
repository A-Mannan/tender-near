export interface PriceView {
  raw: string | null;
  near: string | null;
}

export interface PrintView {
  id: string;
  contract_id: string;
  job_id: string;
  category: string;
  title: string;
  buyer: string;
  winner: string;
  mechanism: "VickreySecondPrice" | "FirstPrice" | string;
  escrow: { kind: "near" } | { kind: "ft"; token_id: string };
  reserve_price: PriceView;
  winning_bid: PriceView;
  runner_up_bid: PriceView;
  clearing_price: PriceView;
  surplus_refunded: PriceView;
  unit_price: PriceView;
  work_units: string;
  unit_label: string;
  commit_count: number;
  reveal_count: number;
  savings_bps: number | null;
  worker_premium_bps: number | null;
  spec_sha256: string;
  deliverable_sha256: string;
  deliverable_uri: string;
  trigger: string;
  settled_at_ns: string;
  block_height: number;
  receipt_id: string;
  tx_hash: string | null;
  log_index: number;
  explorer_url: string | null;
}

export interface TapeResponse {
  network: string;
  count: number;
  total: number;
  limit: number;
  offset: number;
  items: PrintView[];
}

export interface MedianStats {
  count: number;
  priced_count: number;
  units: string[];
  categories: string[];
  median_unit_price: string | null;
  median_unit_price_near: string | null;
  median_clearing_price: string | null;
  median_clearing_price_near: string | null;
  median_winning_bid_near: string | null;
  min_unit_price_near: string | null;
  max_unit_price_near: string | null;
  volume_clearing_near: string;
  buyer_savings_near: string;
  median_savings_bps: number | null;
  median_worker_premium_bps: number | null;
  by_category?: Array<{ category: string; stats: CategoryMedian }>;
}

export interface CategoryMedian {
  count: number;
  median_unit_price: string | null;
  median_unit_price_near: string | null;
  median_clearing_price_near: string | null;
  volume_clearing_near: string;
  median_savings_bps: number | null;
}

export interface SpreadStats {
  count: number;
  units: string[];
  min_unit_price_near: string | null;
  max_unit_price_near: string | null;
  p25_unit_price_near: string | null;
  p75_unit_price_near: string | null;
  median_unit_price_near: string | null;
  spread: string | null;
  spread_near: string | null;
  spread_bps: number | null;
}

export interface WinRateRow {
  worker: string;
  wins: number;
  reveals: number;
  win_rate_bps: number | null;
  volume_won: string;
  volume_won_near: string;
}

export interface WinRateResponse {
  count: number;
  items: WinRateRow[];
}

export interface JobView {
  id: string;
  contract_id: string;
  job_id: string;
  buyer: string;
  title: string;
  category: string;
  spec_sha256: string;
  spec_uri: string;
  work_units: string;
  unit_label: string;
  escrow: { kind: "near" } | { kind: "ft"; token_id: string };
  mechanism: "VickreySecondPrice" | "FirstPrice" | string;
  reserve_price: PriceView;
  min_worker_bond: PriceView;
  max_commits: number;
  arbiter: string | null;
  commit_deadline_ns: string;
  reveal_deadline_ns: string;
  delivery_duration_ns: string;
  dispute_window_ns: string;
  delivery_deadline_ns: string | null;
  created_at_ns: string;
  status: string;
  phase?: string;
  winner: string | null;
  winning_bid: PriceView;
  runner_up_bid: PriceView;
  clearing_price: PriceView;
  unit_price: PriceView;
  deliverable_uri: string;
  deliverable_sha256: string;
  dispute_reason_sha256: string | null;
  settle_trigger: string | null;
  settled_at_ns: string | null;
  surplus_refunded: PriceView;
  commit_count: number;
  reveal_count: number;
  last_event_block: number;
  last_event_timestamp_ns: string;
  network: string;
}

export interface JobsResponse {
  network: string;
  count: number;
  total: number;
  items: JobView[];
}

export interface JobEvent {
  contract_id: string;
  job_id: string | null;
  event: string;
  data: Record<string, unknown>;
  receipt_id: string;
  tx_hash: string | null;
  block_height: number;
  block_timestamp_ns: string;
  log_index: number;
  data_index: number;
}

export interface JobDetail {
  job: JobView;
  print: PrintView | null;
  events: JobEvent[];
}

export interface Facets {
  categories: string[];
  units: string[];
  contracts: string[];
  escrows: string[];
}

export interface Health {
  ok: boolean;
  network: string;
  rpc_url: string;
  contracts: string[];
  counts: { events: number; jobs: number; prints: number; blocks: number };
  latest_block: { height: number; hash: string; timestamp_ns: string } | null;
  indexer: {
    running: boolean;
    last_sync_at: string | null;
    last_error: string | null;
    last_rpc_height: number | null;
    last_indexed_height: number | null;
    syncs: number;
    total_events: number;
    total_blocks: number;
  };
  uptime_s: number;
  server_time: string;
}
