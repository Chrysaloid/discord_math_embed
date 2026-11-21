# discord_math_embed

A Cloudflare Worker that works out a math expression from the URL and puts the result in the
link's Open Graph tags. Paste the link into Discord and the embed shows the answer:

    https://discord-math-embed.<your-subdomain>.workers.dev/embed?expression=2%2B2   ->   "2+2 = 4"

`expr` is accepted as a shorter name for `expression`. The expression must be URL-encoded
(`+` is `%2B`, `/` is `%2F`, `^` is `%5E`, a space is `%20`). It is evaluated by
[math.js](https://mathjs.org/docs/expressions/syntax.html), with the functions that reach outside
one evaluation disabled. [src/index.js](src/index.js)'s header has the details.

## Run locally

    npm install
    wrangler dev            # http://127.0.0.1:8787/embed?expression=2%2B2

## Deploy

    wrangler login          # once, opens the browser for the Cloudflare account
    wrangler deploy

On the free plan a request gets 10 ms of CPU time. An expression that needs more (a huge
matrix, `factorial(100000)`) returns Cloudflare's error page, and Discord shows no embed for it.
Discord caches an embed per URL, so changing the Worker does not update links already posted.
