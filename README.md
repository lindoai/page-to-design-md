# Page to DESIGN.md

Generate a lightweight design snapshot from a public page.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lindoai/page-to-design-md)

## Features

- extracts color candidates
- summarizes heading structure
- detects likely font-family declarations
- returns JSON or markdown output

## Local development

```bash
npm install
npm run dev
npm run typecheck
```

## Deploy

```bash
npm run deploy
```

## Production env

- `TURNSTILE_SITE_KEY`
- `TURNSTILE_SECRET_KEY`

## API

### GET `/api/design?url=https://example.com`

Returns JSON design metadata.

### GET `/api/design?url=https://example.com&format=markdown`

Returns `text/markdown`.
