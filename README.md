# fastmark

A faster drop-in for [marked](https://github.com/markedjs/marked) 18.1.3:
`parse(markdown)` returns exactly the HTML marked renders with its default
options (GFM on), for less CPU. Built for the make.fun
`markdown-render-speed-02` bounty.

## Layout

- `parse.js` — dependency-free ES module exporting `parse(markdown)`.
  A fork of marked 18.1.3 with the defaults baked in and the hot paths
  optimised (see NOTICE for what changed).
- `main.ts` — the harness driver: reads `/input/cases.json`, renders each
  case alone, writes `/output/html.json`.
- `LICENSE` — marked's MIT licence (plus the Markdown BSD notice).
- `NOTICE` — fork credit and the list of behaviour-preserving changes.

## Check locally

```sh
node --check parse.js
# against the kit's practice set (720 cases, must all match byte for byte):
node /tmp/mdtest/test.mjs ./parse.js
node /tmp/mdtest/bench.mjs ./parse.js fastmark
```
