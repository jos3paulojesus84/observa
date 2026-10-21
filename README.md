# observa

Streaming Experience Observability: one system that goes from impacted viewers (how many, where, what broke) to why, by lining player QoE and backend services up on the same UTC minute.

The design lives in the documents at the root of the repository:

| File | What it is |
|---|---|
| `1pager.pdf` | The pitch: problem, solution, value, what must be proven |
| `streaming-experience-observability-v7.html` | Architecture specification v7, the implementation contract |
| `observability-data-flow-v3.html` | One minute of video followed end to end, with schemas and byte counts |
| `qoe-explorer-experience.html` | Session-centric QoE Explorer prototype |
| `minute-explorer.html` | Minute Explorer prototype, built from `apps/minute-explorer` |

## Layout

```
packages/core          @observa/core: Phase 0 reference implementation (spec §19)
apps/minute-explorer   Minute Explorer: the QoE Explorer's workflows on minute records
```

### `@observa/core`

The on-device half of the measurement model, in TypeScript with no runtime dependencies:

- `vocabulary.ts`: the fixed state machine states, issue bits, context-change flags and observation vocabulary (§6, §14.2)
- `ruleset.ts`, `default-ruleset.ts`: the declarative classification ruleset, its validator and the compiled-in known-good pack (§14). Thresholds are tier-1 parameters the rules reference as `$name`, with client-side sanity bounds (§13.1)
- `compiler.ts`: `MinuteCompiler`, which turns normalised player inputs into `ExperienceMinute`, `PlaybackAttempt`, `PlaybackInterval` and `ContextDefinition` records sealed on UTC wall-clock minutes (§3, §7)
- `ladder.ts`: the shared log-scale duration ladder used by both the SDK and the services lane, and bitrate buckets (§3.7, §12.1)
- `packing.ts`, `batch.ts`: the 24-byte packed record, the batch envelope and the upload stagger (§7.2, §17.1)
- `adapters/html5.ts`: an HTML5 media-element adapter and the replay harness

Two choices go slightly beyond the spec's text:

1. Rules name a trigger in `on` (`segment_end`, `tick`, `seal`, `error`). A rebuffer can only be judged once the buffering segment ends, while a stall-out must fire while the player is still buffering.
2. The observation vocabulary adds `next_state`, `progress_stall_ms` and `error_fatal`, each a value the state machine already computes.

The tests replay the data-flow document's 12:11 minute from its stage-01 event log. One finding from that replay: under the v7 taxonomy that minute also qualifies as `QUALITY_DEGRADATION` (48 s below the peak rendition), which the document's `0x02` bitmap predates. The bit is outside the headline mask, so headline impact is unchanged.

### Minute Explorer

The QoE Explorer's analytics workflows, rebuilt on the minute record. The triage findings and alerts, scope filters and conditions, metric cards with drag-to-slice, previous-period compare, pinned values, separate and combined breakdowns, and the viewer roll-up all behave as before; what changed is the unit underneath them.

- **The headline is minutes.** % issue-free minutes (or % minutes with issues) with the minute counts beside it, against an objective and burn rate. Content and ad minutes are scored separately (§3.4); an optional switch weights minutes by intent seconds, as §4 defines Issue-Free Opportunity.
- **It is composed of components.** The out-of-the-box components are the §6.2 issue bits set on the device. Custom components are a customer's own thresholds on fields every minute record carries (rebuffer time, rebuffer count, startup time, delivered bitrate, time at peak rendition, freeze time), evaluated server-side at bucket resolution (§13.3), so they apply to history too. A minute with issues is the union of the switched-on components. Each component is a metric: a card, a table column, a finding, a drill.
- **Playbacks are timelines of minutes.** A playback opens as the minute records its device sealed: minute health, which components fired, bitrate, the rebuffer bucket, seconds at peak, content and ad intervals, and sequence gaps where a minute never arrived. Selecting a minute shows the record and its 24 bytes on the wire. There is no event stream, because none leaves the device unless a forensic policy targets it (§11). The sampled playbacks are compiled in the page by `@observa/core`.
- **Spec limits are visible.** Content dimensions are not in the minute cube (§5.2), so an asset breakdown is labelled as the raw-tier path (§8.6). Failed and abandoned starts are attempts (§3.3) and have their own acquisition metrics.

All data is a generated scenario behind the same `callTool()` seam the explorer used; a query service over the minute cube, raw minute tier and playback store would answer the same calls.

## Commands

```sh
npm install
npm test            # core tests (vitest)
npm run typecheck   # core type check
npm run build       # builds core to dist/ and minute-explorer.html at the root
```
