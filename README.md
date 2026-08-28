# On-Page SEO Analyzer

[![CI](https://github.com/filipkonecny06/seo-analyzer/actions/workflows/ci.yml/badge.svg)](https://github.com/filipkonecny06/seo-analyzer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-0f766e.svg)](LICENSE)

A Node.js application that fetches one public HTML page and reports common on-page SEO signals. Its
100-point score is a review aid backed by visible checks and evidence, not a search-ranking forecast.

## Highlights

- Standards-based HTML parsing with Cheerio instead of regular expressions
- Eleven scoring rules with visible evidence and weights
- DNS-aware SSRF controls that validate and pin every redirect hop
- Fetch and analysis deadlines plus redirect, response-size, rate, memory, and concurrency limits
- Accessible, responsive interface built with semantic HTML and browser JavaScript
- Server, network, clock, and analysis boundaries that can be replaced in tests
- CI across supported Node.js lines, production dependency auditing, and container verification

## Architecture

```text
Browser
  │ GET /api/analyze?url=…
  ▼
createServer
  ├── InMemoryRateLimiter + ConcurrencyGate
  ├── SafePageFetcher
  │     └── UrlSafetyPolicy → DNS validation → IP-pinned HTTP(S) request
  └── WorkerAnalysisRunner (deadline + memory limits)
        └── SeoAnalyzer
              ├── PageSnapshot (Cheerio extraction)
              └── AnalysisRule registry → checks, score, recommendations
```

The server is created by `createServer(options)` and only begins listening in `server.js`, so tests
can replace the fetcher or analyzer without opening outbound connections.

```text
src/
├── analysis/
│   ├── analysis-runner.js   # Isolated worker lifecycle, deadline, and limits
│   ├── analysis-worker.js   # Worker entry point for parsing and scoring
│   ├── page-snapshot.js     # Parse once and expose normalized evidence
│   ├── rules.js             # Named rules and the default rule registry
│   └── seo-analyzer.js      # Registry validation, scoring, prioritization
├── http/
│   ├── create-server.js     # Routes, headers, static files, error contract
│   └── limits.js            # Stateful single-process abuse controls
├── network/
│   ├── safe-page-fetcher.js # Bounded, manually redirected HTTP(S)
│   └── url-safety-policy.js # URL, DNS, IP, port, and credential policy
├── analyzer.js              # Small public analysis facade
├── config.js                # Validated environment configuration
├── errors.js                # Safe operational error types
└── version.js               # Application and methodology identifiers
```

Browser behavior is split between `public/analyzer-app.mjs`, `public/report-renderer.mjs`, and
`public/ui-utils.mjs`; `public/app.js` only starts the application.

## Scoring model

The score is a prioritization aid, not a search-ranking prediction. Character ranges are heuristics;
search engines may rewrite snippets, and page intent matters more than blindly reaching a threshold.

| Rule                | Points | What is evaluated                                          |
| ------------------- | -----: | ---------------------------------------------------------- |
| Title tag           |     15 | Presence and a practical character range                   |
| Meta description    |     15 | Presence and a practical character range                   |
| Heading structure   |     10 | H1 presence, multiplicity, and skipped levels              |
| Image alternatives  |     10 | Missing `alt`; empty `alt=""` is accepted as decorative    |
| Canonical URL       |     10 | Presence and a resolvable HTTP(S) target                   |
| Indexing directives |     10 | Robots/Googlebot meta and `X-Robots-Tag`, including `none` |
| Content depth       |     10 | Approximate visible Unicode word count                     |
| Mobile viewport     |      5 | Device-width viewport configuration                        |
| Document language   |      5 | Presence and plausible BCP 47 shape                        |
| Open Graph          |      5 | Title, description, and image baseline                     |
| Structured data     |      5 | Object/array JSON-LD blocks with non-empty `@type` values  |

Rule weights are validated at startup and must total exactly 100.

## Security model

Analyzing arbitrary URLs creates an SSRF boundary. `UrlSafetyPolicy` and `SafePageFetcher` apply the
following controls:

1. Accept only HTTP(S), reject embedded credentials, and allow ports 80/443 by default.
2. Resolve A and AAAA records concurrently with an independent resolver for each authorization;
   cancel both queries on timeout or caller abort, and reject the request if **any** answer is not
   globally routable.
3. Pin the approved address into the socket lookup, reducing DNS-rebinding exposure between policy
   evaluation and connection establishment.
4. Disable automatic redirects; resolve, validate, and pin every redirect destination independently.
5. Limit redirects, each DNS lookup, the complete redirect chain, URL length, and response bytes;
   cancel outbound work when the client disconnects.
6. Request identity encoding and reject unexpected compressed bodies so the byte limit is explicit.
7. Parse and score HTML in a worker thread with its own deadline, V8 heap limits, and stack limit;
   terminate and await the worker on timeout or client disconnect.
8. Apply per-process IP rate limits and a global concurrent-analysis cap that spans fetching and
   worker termination.
9. Return structured public errors without exposing resolver, socket, or worker internals.

The HTTP server also sets a restrictive Content Security Policy, clickjacking protection, MIME
sniffing protection, a no-referrer policy, no-store API caching, method allowlists, and safe static-path
containment. Malformed percent encoding returns `400` instead of terminating the process.

The built-in limiter is intentionally single-process. A multi-instance deployment should enforce a
shared rate limit at a trusted reverse proxy or gateway. Set `TRUST_PROXY=true` only when requests can
reach the application exclusively through that trusted proxy.

## Run locally

Requirements: a supported Node.js version matching `package.json` (22.13+ or 24.x) and npm. The
`packageManager` field records npm 11.13.0 as the lockfile maintenance version. The repository includes
`.nvmrc`; run `nvm use` to select Node.js 24 where nvm is available.

```bash
npm ci
npm start
```

Open <http://localhost:3000>. For automatic restarts during development:

```bash
npm run dev
```

Copy `.env.example` values into your process environment when defaults need to change. The app does
not load `.env` files implicitly; that keeps runtime configuration explicit and platform-neutral.

## API

### Analyze a page

```http
GET /api/analyze?url=https%3A%2F%2Fexample.com
Accept: application/json
```

Successful response (abridged):

```json
{
  "ok": true,
  "url": "https://example.com/",
  "fetchedAt": "2026-08-28T00:00:00.000Z",
  "network": { "redirectCount": 0 },
  "report": {
    "score": 82,
    "maxScore": 100,
    "grade": "B",
    "methodologyVersion": "2.0",
    "metadata": {},
    "content": {},
    "checks": [],
    "recommendations": []
  }
}
```

Errors always use one shape:

```json
{
  "ok": false,
  "error": {
    "code": "NON_PUBLIC_ADDRESS",
    "message": "The target resolves to a non-public network address."
  }
}
```

Other endpoint: `GET` or `HEAD /api/health`. Do not place credentials or private tokens in analyzed
URLs: query strings can be retained by browsers and infrastructure logs.

## Configuration

| Variable                      |                   Default | Purpose                                   |
| ----------------------------- | ------------------------: | ----------------------------------------- |
| `HOST`                        |                 `0.0.0.0` | Listening interface                       |
| `PORT`                        |                    `3000` | Listening port                            |
| `REQUEST_TIMEOUT_MS`          |                   `15000` | Incoming request timeout                  |
| `TRUST_PROXY`                 |                   `false` | Trust the first `X-Forwarded-For` address |
| `OUTBOUND_USER_AGENT`         | `OnPageSEOAnalyzer/2.0.0` | Outbound identifier                       |
| `ALLOWED_TARGET_PORTS`        |                  `80,443` | Allowed destination ports                 |
| `DNS_TIMEOUT_MS`              |                    `3000` | DNS lookup deadline                       |
| `FETCH_TIMEOUT_MS`            |                   `10000` | Deadline for the complete redirect chain  |
| `MAX_RESPONSE_BYTES`          |                 `2000000` | Maximum HTML body size                    |
| `MAX_REDIRECTS`               |                       `4` | Maximum validated redirect hops           |
| `MAX_URL_LENGTH`              |                    `2048` | Maximum target URL length                 |
| `RATE_LIMIT_MAX`              |                      `10` | Analyses per client/window                |
| `RATE_LIMIT_WINDOW_MS`        |                   `60000` | Rate-limit window                         |
| `MAX_CONCURRENT_ANALYSES`     |                       `4` | Simultaneous outbound analyses            |
| `ANALYSIS_TIMEOUT_MS`         |                    `5000` | HTML parse-and-score deadline             |
| `ANALYSIS_MAX_OLD_SPACE_MB`   |                     `128` | Worker old-generation heap limit          |
| `ANALYSIS_MAX_YOUNG_SPACE_MB` |                      `16` | Worker young-generation heap limit        |
| `ANALYSIS_STACK_SIZE_MB`      |                       `4` | Worker stack limit                        |

Invalid configuration fails fast with a descriptive startup error.

## Tests and quality gates

```bash
npm test                 # Node unit and integration tests
npm run test:coverage    # Per-file coverage gates for server and browser behavior
npm run lint             # ESLint flat config
npm run format           # Apply Prettier formatting
npm run format:check     # Prettier verification
npm run check            # All local quality gates
npm run audit:production # Production dependency audit (moderate and above)
```

The suite covers parser regressions, Unicode keywords, scoring invariants, robots and image semantics,
IPv4/IPv6 network classification, mixed DNS answers, redirect-to-private blocking, IP pinning,
response and redirect-chain limits, cancellation, worker deadlines and termination, repeated robots
headers, rate/concurrency behavior, HTTP contracts, security headers, traversal attempts, browser
request races, safe DOM rendering, and deployment-file invariants. Per-file coverage gates apply
separately to server modules under `src/` and browser behavior modules under `public/*.mjs`. The
two-line `public/app.js` bootstrap is checked as a static project invariant, and the root `server.js`
bootstrap is exercised by the container smoke test.

## Manage the rule set

To add or change a check:

1. Add a focused `AnalysisRule` subclass in `src/analysis/rules.js`.
2. Give it a stable ID, user-facing label, maximum points, evidence, and actionable recommendation.
3. Register it in `DEFAULT_RULES` and rebalance weights to exactly 100.
4. Add pass/warn/fail fixtures in `test/analyzer.test.js`.
5. Run `npm run check` and document material methodology changes.

Parsing belongs in `PageSnapshot`; rules should evaluate normalized evidence rather than traverse the
DOM independently. This keeps one parse per report and makes rule behavior easy to inspect.

## Container deployment

```bash
docker build -t seo-analyzer .
docker run --rm --init -p 3000:3000 --env-file .env seo-analyzer
```

The image uses a non-root runtime user, installs production dependencies only, exposes a health check,
isolates HTML analysis in bounded workers, and handles `SIGINT`/`SIGTERM` with graceful server
shutdown. CI starts the built image and probes its health endpoint. Put TLS, shared rate limiting,
request logging, and horizontal scaling at the platform edge.

## Limitations

- This is a single-page heuristic analyzer, not a crawler.
- Pages that exceed the configured analysis deadline or worker memory limits are rejected instead of
  producing a partial report.
- It does not execute client-side JavaScript, render CSS, or measure Core Web Vitals.
- It does not inspect backlinks, index coverage, robots.txt, XML sitemaps, or search-console data.
- Keyword frequency is descriptive, not a recommendation to increase keyword density.
- JSON-LD blocks must parse to an object or array and declare a non-empty `@type` to receive full
  points; schema semantics and search-feature eligibility still require a specialist validator.
- Search-result title and description display depends on rendered width and search-engine rewriting,
  so character ranges are guidance rather than guarantees.

## License

[MIT](LICENSE)
