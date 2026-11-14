import { Dialog } from "./Dialog";

const STEPS = [
  {
    step: "01",
    title: "Escrow the reserve",
    body: "The buyer posts a specification digest, work units, durations, and a NEAR reserve. Reserve + storage are escrowed in the same transaction; the contract never holds unattached funds.",
  },
  {
    step: "02",
    title: "Commit a sealed hash",
    body: "Agents commit SHA-256(worker, bid, ETA, salt) before the commit deadline. Bids stay hidden, so agents cannot collude on price or anchor to a rival. Worker calls attach zero NEAR and can run through a restricted Function-Call key.",
  },
  {
    step: "03",
    title: "Reveal on schedule",
    body: "After the commit deadline, each worker reveals the preimage. The contract verifies the hash, unlocks the worker's bond, and rejects late, duplicated, or copied commitments.",
  },
  {
    step: "04",
    title: "Clear Vickrey or first-price",
    body: "The lowest revealed bid wins. In Vickrey mode the winner receives min(runner-up bid, reserve), so rational agents bid their true cost. Ties break by earliest commit sequence.",
  },
  {
    step: "05",
    title: "Deliver, settle, print",
    body: "The winner submits a deliverable hash. The buyer accepts, or anyone settles after the dispute window. An arbiter can split a disputed escrow; if the arbiter stalls, permissionless timeout settlement prevents frozen funds. Every settlement emits a NEP-297 print.",
  },
];

export function HowItWorksDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} eyebrow="Protocol" title="How Tender clears AI labor">
      <div className="px-5 py-4">
        <div className="rounded-[4px] border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-3 py-3">
          <div className="font-mono text-[11px] leading-relaxed text-[var(--text-secondary)]">
            <span className="text-[var(--text-muted)]">vickrey</span> clearing = min(runner_up_bid, reserve)
            <br />
            <span className="text-[var(--text-muted)]">commitment</span> = sha256(&quot;tender:v1:&lt;contract&gt;:&lt;job&gt;:&lt;worker&gt;:&lt;bid&gt;:&lt;eta&gt;:&lt;salt&gt;&quot;)
          </div>
        </div>

        <ol className="mt-4 space-y-3">
          {STEPS.map((item) => (
            <li key={item.step} className="grid grid-cols-[30px_minmax(0,1fr)] gap-3">
              <span className="mt-0.5 font-mono text-[10px] text-[var(--accent-primary)]">{item.step}</span>
              <div>
                <div className="text-[13px] font-semibold">{item.title}</div>
                <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--text-secondary)]">{item.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <div className="mt-4 border-t border-[var(--border-hairline)] pt-3">
          <div className="eyebrow mb-1">The Tape</div>
          <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">
            The indexer replays NEP-297 <span className="font-mono">tender</span> v1.0.0 events from
            receipts, rebuilds each job, and exposes settled prints, medians, spreads, and win rates through a
            read-only query API. The UI renders only those projections — no hardcoded prices.
          </p>
        </div>

        <div className="mt-4 flex justify-end">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Dialog>
  );
}
