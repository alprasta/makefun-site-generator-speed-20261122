# makefun-site-generator-speed-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/alprasta/makefun-site-generator-speed-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/alprasta/makefun-site-generator-speed-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast, dependency-free drop-in for make.fun's own makefun-site 1.0.0 static site generator, written for the site-generator-speed-01-run-20261122 bounty. `run(input)` in `solve.js` returns exactly the output tree makefun-site returns for one case's input — every page's `index.html`, the index and tag pages, `build-report.txt`, and each static file, byte for byte.

`main.ts` is the driver the harness runs: it reads every case from `/input/cases.json`, answers each with `run()`, and writes `/output/answers.json`.

The implementation is original work, written from the published rules. It is a single pass per source with per-case caches for pure string functions (slugify, long dates) and for template includes whose rendering depends only on values that do not change between renders.

## Run it

```sh
node main.ts
```

Outside the container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=58yp00jq&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
