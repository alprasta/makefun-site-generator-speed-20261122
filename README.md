# site-generator-speed-20261122

A fast, dependency-free drop-in for make.fun's own makefun-site 1.0.0 static
site generator, written for the site-generator-speed-01-run-20261122 bounty.

`run(input)` in `solve.js` returns exactly the output tree makefun-site
returns for one case's input — every page's `index.html`, the index and tag
pages, `build-report.txt`, and each static file, byte for byte. `main.ts`
is the driver the harness runs: it reads every case from
`/input/cases.json`, answers each with `run()`, and writes
`/output/answers.json`.

The implementation is original work, written from the published rules. It is
a single pass per source with per-case caches for pure string functions
(slugify, long dates) and for template includes whose rendering depends only
on values that do not change between renders.
