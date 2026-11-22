# discord_math_embed

A Cloudflare Worker that works out a math expression from the URL and puts the result in the
link's Open Graph tags. Paste the link into Discord and the embed shows the answer:

    https://discord-math-embed.chrysaloid.workers.dev/embed?expression=2%2B2   ->   "2+2 = 4"

`expr` is accepted as a shorter name for `expression`. The expression must be URL-encoded
(`+` is `%2B`, `/` is `%2F`, `^` is `%5E`, a space is `%20`). It is evaluated by
[math.js](https://mathjs.org/docs/expressions/syntax.html), with the functions that reach outside
one evaluation disabled. [src/index.ts](src/index.ts)'s header has the details.

Opened in a browser, the same page ([src/embed.html](src/embed.html)) is an embed creator that does
the encoding for you: type an expression, see a live preview of the Discord embed, and copy the
masked link to paste, such as
`[2+2 = 4](https://discord-math-embed.chrysaloid.workers.dev/embed?expression=2%2B2)`. So clicking an
embed's title on Discord opens the creator with that expression. Discord reads only the page's meta
tags and runs none of its JavaScript. `/embed` is the only path; every other one redirects to it.

The creator evaluates in the browser, so typing sends no requests. The math.js setup and the embed
building live in [src/build_embed.ts](src/build_embed.ts), used by both the Worker
([src/index.ts](src/index.ts)) and the creator ([src/creator.ts](src/creator.ts)). esbuild bundles
the creator, math.js included, into `dist/creator.js` (git-ignored, generated), which Cloudflare
serves as a static asset without running the Worker. Since a browser is not held to the Worker's
CPU limit (see Deploy), the creator warns when an expression took longer than that to evaluate.

## Build

    npm run build           # esbuild src/creator.ts -> dist/creator.js

wrangler runs it by itself (`[build]` in [wrangler.toml](wrangler.toml)) before `wrangler dev`,
`wrangler deploy` and `wrangler types`, and again in `wrangler dev` when something in `src/` changes,
so it rarely needs running by hand. `esbuild` is the global npm install.

## Run locally

    npm install
    wrangler dev            # http://127.0.0.1:8787/embed?expression=2%2B2

or [run_local_server.ps1](run_local_server.ps1) (F5 works), which type-checks first and on a type
error stops, leaving the previous run's server running; otherwise it closes the previous run's tab,
runs `wrangler dev` in a Windows Terminal tab of its own, and returns once the server answers.

## Profile

    python profile_fetch.py                 # with the local server running; F5 works
    python profile_fetch.py "factorial(170)" -n 10000 --flame

[profile_fetch.py](profile_fetch.py) records the V8 CPU profile of `wrangler dev` (workerd) through
its inspector while it sends an expression to `/embed` thousands of times, and prints where
`fetch()` spends its time: functions by total and self share, a top-down call tree, and the lines of
`src/` - all mapped back from wrangler's bundle to `src/` and `node_modules/`. It saves each profile,
source-mapped, to `profiles/` (git-ignored); `--flame` opens it as a flame graph in speedscope (the
global npm install). Its docstring explains why it reports shares of samples and not milliseconds:
workerd's sampler on Windows takes only about one sample per 15 ms of busy time.

## Type-check

The Worker is TypeScript, which wrangler bundles as it is; nothing compiles it to JavaScript.

    npm run typecheck       # wrangler types && tsc && tsc -p tsconfig.creator.json

`wrangler types` writes `worker-configuration.d.ts` (the Workers runtime types and `Env`, from
`wrangler.toml`; git-ignored, since it is generated), and `tsc` checks against it without emitting
anything. The browser side, [src/creator.ts](src/creator.ts), needs the DOM types instead, so
[tsconfig.creator.json](tsconfig.creator.json) checks it, and `tsconfig.json` leaves it out;
`src/build_embed.ts` gets checked by both. Both `wrangler` and `tsc` are the global npm installs.

## Deploy

    wrangler login          # once, opens the browser for the Cloudflare account
    npm run deploy          # type-checks first (predeploy), then wrangler deploy

A bare `wrangler deploy` skips the type check: wrangler strips the types without checking them,
so it uploads code with type errors too.

On the free plan a request gets 10 ms of CPU time. An expression that needs more (a huge
matrix, `factorial(100000)`) returns Cloudflare's error page, and Discord shows no embed for it.
Discord caches an embed per URL, so changing the Worker does not update links already posted.
