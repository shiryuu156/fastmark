[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/shiryuu156/fastmark/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/shiryuu156/fastmark/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

# fastmark

A faster drop-in for [marked](https://github.com/markedjs/marked) 18.1.3:
`parse(markdown)` returns exactly the HTML marked renders with its default
options (GFM on), for less CPU. Built for the make.fun
`markdown-render-speed-02` bounty.

## Results (2026-11-16)

- Practice set: **720/720 cases byte-for-byte identical** to marked 18.1.3,
  including the end-to-end `main.ts` run (720 outputs, 0 mismatches).
- Speed: **~1.75x faster than marked itself** on the full 720-case set,
  measured by interleaved CPU time (marked ~731ms, fastmark ~418ms per
  full-set pass on this VM).
- Differential fuzzing against marked: **78,000 generated inputs, 0
  mismatches** (mutations of practice cases, random markdown soup,
  structured fragments, doc slices, and large doc-like inputs).

## Layout

- `parse.js` — dependency-free ES module exporting `parse(markdown)`.
  A fork of marked 18.1.3 with the defaults baked in and the hot paths
  optimised (see NOTICE for what changed).
- `main.ts` — the harness driver: reads `/input/cases.json`, renders each
  case alone, writes `/output/html.json` (a JSON array of HTML strings,
  one per case, in the cases' order).
- `LICENSE` — marked's MIT licence (plus the Markdown BSD notice).
- `NOTICE` — fork credit and the list of behaviour-preserving changes.

## Check locally

```sh
node --check parse.js
# against the kit's practice set (720 cases, must all match byte for byte):
node /tmp/mdtest/test.mjs "$PWD/parse.js"
# end to end through main.ts:
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=/tmp/mdout node main.ts
node /tmp/mdtest/e2e.mjs
```

## Submission

Submitted to the make.fun `markdown-render-speed-02` bounty as the
shiryuu156/fastmark entry. Final verified state, re-recorded 2026-11-16:

- 720/720 practice cases byte-identical to marked 18.1.3 (including the
  end-to-end `main.ts` run — 720 outputs, 0 mismatches).
- 1.746x faster than marked on the full 720-case set (interleaved CPU time:
  marked ~731ms vs fastmark ~418ms per full-set pass on this VM).
- 78,000 differential fuzz inputs against marked, 0 mismatches.

No behaviour changed after verification — this commit only records the
final state (submission notes and header comments) so the entry's
transcripts cover it.
