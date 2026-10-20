# observa

Streaming Experience Observability: one system that goes from impacted viewers (how many, where, what broke) to why, by lining player QoE and backend services up on the same UTC minute.

The design lives in the documents at the root of the repository:

| File | What it is |
|---|---|
| `1pager.pdf` | The pitch: problem, solution, value, what must be proven |
| `streaming-experience-observability-v7.html` | Architecture specification v7, the implementation contract |
| `observability-data-flow-v3.html` | One minute of video followed end to end, with schemas and byte counts |
| `qoe-explorer-experience.html` | Session-centric QoE Explorer prototype |
| `minute-console.html` | Minute Console prototype, built from `apps/minute-console` |

## Layout

```
packages/core          @observa/core: Phase 0 reference implementation (spec §19)
apps/minute-console    Minute Console: a front end built entirely on minute records
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

### Minute Console

A troubleshooting surface where every view is a projection of minute records:

- the minute grid: sampled playbacks × UTC minutes, each cell an `ExperienceMinute` compiled in the page by `@observa/core`, with a population strip per served edge from the minute cube
- the headline per minute (issue-free opportunity with its impacted seconds, never the rate alone), content and ads as separate lanes
- cohorts ranked by excess impact, with the worst-rate cohort shown outside the ranking
- the aligned view: viewer impact and the service cube joined on minute × edge × region
- the two independent tests (mix shift and within-cohort), completeness per platform tier, service agent coverage
- a playback inspector showing a record and its 24 bytes on the wire

Each minute shows its state: open on devices, filling as staggered uploads arrive, or sealed. The scenario clock can be scrubbed or played to watch minutes fill, seal and raise the alert. All data is a generated scenario based on the data-flow document's incident; the page reads it through one `callTool()` seam that a real query service could answer.

## Commands

```sh
npm install
npm test            # core tests (vitest)
npm run typecheck   # core type check
npm run build       # builds core to dist/ and minute-console.html at the root
```
