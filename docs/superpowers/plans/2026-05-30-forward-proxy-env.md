# Forward Proxy Environment Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace embedded and legacy forward-proxy endpoint selection with one validated `FORWARD_PROXY` environment variable across CB01, Uprot, Mediaflow and CinemaCity.

**Architecture:** Add a focused `core/proxy/forward_proxy_config.js` authority that validates configuration and builds encoded forward URLs. Existing consumers delegate endpoint selection and URL building to this module while keeping their provider-specific enable flags, timeout controls and forwarded headers.

**Tech Stack:** Node.js CommonJS, built-in `URL`, built-in `node:test`, Docker Compose environment configuration.

---

### Task 1: Shared Forward Proxy Authority

**Files:**
- Create: `core/proxy/forward_proxy_config.js`
- Create: `tests/forward_proxy_config.test.js`

- [ ] **Step 1: Write failing tests**

Cover reading only `FORWARD_PROXY`, target URL encoding, query parameter forwarding,
missing configuration, invalid configuration and invalid target URLs.

- [ ] **Step 2: Run the shared helper test**

Run: `node --test tests/forward_proxy_config.test.js`

Expected: FAIL because `core/proxy/forward_proxy_config.js` does not exist.

- [ ] **Step 3: Implement the helper**

Export:

```js
getForwardProxyBase(options)
requireForwardProxyBase(context, options)
buildForwardProxyUrl(targetUrl, options)
createForwardProxyConfigError(message, context)
```

Use error code `FORWARD_PROXY_CONFIG_ERROR`.

- [ ] **Step 4: Run the shared helper test**

Run: `node --test tests/forward_proxy_config.test.js`

Expected: PASS.

### Task 2: Integrate CB01, Uprot and Mediaflow

**Files:**
- Modify: `providers/cb01/cb01_handler.js`
- Modify: `providers/extractors/hosters/uprot.js`
- Modify: `core/proxy/mediaflow_gateway.js`
- Modify: `tests/cb01_provider.test.js`
- Modify: `tests/uprot_extractor.test.js`
- Create: `tests/mediaflow_forward_proxy.test.js`

- [ ] **Step 1: Write failing consumer tests**

Cover:

```js
process.env.FORWARD_PROXY = 'https://proxy.example/forward?url=';
```

and assert that CB01, Uprot and Mediaflow build encoded forward URLs from that
single environment variable. Assert that legacy aliases alone are ignored.

- [ ] **Step 2: Run the focused consumer tests**

Run:

```powershell
node --test tests/cb01_provider.test.js tests/uprot_extractor.test.js tests/mediaflow_forward_proxy.test.js
```

Expected: FAIL because consumers still read legacy aliases or embedded defaults.

- [ ] **Step 3: Replace endpoint selection**

Import the shared authority in all three consumers. Remove embedded Kraken URLs,
legacy environment lookup chains and Mediaflow-base fallback for fetch-endpoint
forwarding. Preserve intentional Uprot opt-out with
`uprotForwardProxy: 'false'`.

- [ ] **Step 4: Run the focused consumer tests**

Run:

```powershell
node --test tests/cb01_provider.test.js tests/uprot_extractor.test.js tests/mediaflow_forward_proxy.test.js
```

Expected: PASS.

### Task 3: Integrate CinemaCity

**Files:**
- Modify: `providers/cinemacity/cc_handler.js`
- Modify: `tests/cinemacity_provider.test.js`

- [ ] **Step 1: Write failing CinemaCity tests**

Assert that CinemaCity document forwarding uses `FORWARD_PROXY`, carries
`h_user-agent`, `h_referer` and `h_origin`, and derives the extractor base from
the configured generic endpoint.

- [ ] **Step 2: Run the CinemaCity tests**

Run: `node --test tests/cinemacity_provider.test.js`

Expected: FAIL because CinemaCity still uses its embedded specialized endpoint.

- [ ] **Step 3: Replace CinemaCity endpoint selection**

Use the shared forward URL builder. Remove the embedded
`/cinemacity/fetch?d=` endpoint and legacy CinemaCity endpoint aliases while
keeping behavior flags and timeouts.

- [ ] **Step 4: Run the CinemaCity tests**

Run: `node --test tests/cinemacity_provider.test.js`

Expected: PASS.

### Task 4: Deployment Configuration and Source Guard

**Files:**
- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Create: `tests/forward_proxy_source_guard.test.js`

- [ ] **Step 1: Write the failing source guard**

Assert that production JavaScript contains no embedded
`krakenproxy.questoleviatanormio` forward endpoint and Compose exposes only
`FORWARD_PROXY` for endpoint identity.

- [ ] **Step 2: Run the source guard**

Run: `node --test tests/forward_proxy_source_guard.test.js`

Expected: FAIL while embedded URLs and legacy Compose variables remain.

- [ ] **Step 3: Update deployment configuration**

Document:

```env
FORWARD_PROXY=https://krakenproxy.questoleviatanormio.dpdns.org/forward?url=
```

Remove endpoint identity aliases from Compose. Keep independent flags and
timeouts.

- [ ] **Step 4: Run the source guard**

Run: `node --test tests/forward_proxy_source_guard.test.js`

Expected: PASS.

### Task 5: Verification and GitHub Publication

**Files:**
- Include all changed workspace source files, including the earlier RD probe coordinator work.

- [ ] **Step 1: Run syntax checks**

Run:

```powershell
node --check core/proxy/forward_proxy_config.js
node --check core/proxy/mediaflow_gateway.js
node --check providers/cb01/cb01_handler.js
node --check providers/extractors/hosters/uprot.js
node --check providers/cinemacity/cc_handler.js
```

- [ ] **Step 2: Run focused tests**

Run:

```powershell
node --test tests/forward_proxy_config.test.js tests/cb01_provider.test.js tests/uprot_extractor.test.js tests/mediaflow_forward_proxy.test.js tests/cinemacity_provider.test.js tests/forward_proxy_source_guard.test.js
```

- [ ] **Step 3: Run complete suite**

Run: `npm test`

Expected: PASS with zero failures.

- [ ] **Step 4: Publish all workspace changes**

Create a clean clone of `https://github.com/LUC4N3X/stremio-leviathan-addon`,
copy the workspace source tree excluding dependencies and Git metadata, inspect
the resulting Git diff, commit the intended files on
`codex/centralize-forward-proxy-and-rd-probes`, push and open a draft PR.
