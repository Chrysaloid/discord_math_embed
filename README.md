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

## Run locally

    npm install
    wrangler dev            # http://127.0.0.1:8787/embed?expression=2%2B2

or [run_local_server.ps1](run_local_server.ps1) (F5 works), which type-checks first and on a type
error stops, leaving the previous run's server running; otherwise it closes the previous run's tab,
runs `wrangler dev` in a Windows Terminal tab of its own, and returns once the server answers.

## Type-check

The Worker is TypeScript, which wrangler bundles as it is; nothing compiles it to JavaScript.

    npm run typecheck       # wrangler types && tsc

`wrangler types` writes `worker-configuration.d.ts` (the Workers runtime types and `Env`, from
`wrangler.toml`; git-ignored, since it is generated), and `tsc` checks against it without emitting
anything. Both `wrangler` and `tsc` are the global npm installs.

## Deploy

    wrangler login          # once, opens the browser for the Cloudflare account
    npm run deploy          # type-checks first (predeploy), then wrangler deploy

A bare `wrangler deploy` skips the type check: wrangler strips the types without checking them,
so it uploads code with type errors too.

On the free plan a request gets 10 ms of CPU time. An expression that needs more (a huge
matrix, `factorial(100000)`) returns Cloudflare's error page, and Discord shows no embed for it.
Discord caches an embed per URL, so changing the Worker does not update links already posted.
