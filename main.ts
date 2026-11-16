// fastmark driver for the make.fun markdown-render-speed-02 harness.
//
// The harness runs `node /bot/main.ts` (Node 22, types stripped natively).
// This program reads every case from the input directory, renders each one
// alone with parse() from parse.js, and writes the HTML strings — one per
// case, in the cases' order — to the output directory as a JSON array.
// Outside a container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in
// for /input and /output. No case shares state with any other: parse() is
// stateless across calls, and each case is rendered on its own.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

interface Case {
  id: string;
  markdown: string;
}

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as Case[];
const html = new Array<string>(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
