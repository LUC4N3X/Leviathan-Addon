# Forward Proxy Environment Configuration Design

## Goal

Use one environment variable for every forward-proxy fetch endpoint:

```env
FORWARD_PROXY=https://krakenproxy.questoleviatanormio.dpdns.org/forward?url=
```

Remove embedded proxy endpoints and legacy environment aliases from runtime
selection. A missing or invalid `FORWARD_PROXY` value is a configuration error
for flows that require forward-proxy transport.

## Current Problem

Forward-proxy transport is selected independently in several modules:

- CB01 has an embedded `CB01_FORWARD_PROXY` code default and reads legacy env
  aliases.
- Uprot has an embedded Kraken URL and reads multiple provider-specific aliases.
- Mediaflow forward URL construction reads a chain of provider-specific aliases.
- CinemaCity has an embedded specialized `/cinemacity/fetch?d=` endpoint.
- Docker Compose exposes multiple overlapping environment variables.

The duplicated configuration makes deployments fragile: updating one endpoint
does not reliably update every forward-proxy flow.

## Architecture

Create `core/proxy/forward_proxy_config.js` as the only runtime authority for
fetch-endpoint forward proxy configuration.

The module exports:

```js
getForwardProxyBase()
requireForwardProxyBase(context)
buildForwardProxyUrl(targetUrl, options)
```

`getForwardProxyBase()` reads only `process.env.FORWARD_PROXY`. It returns an
empty string when the value is absent and rejects malformed URL values.

`requireForwardProxyBase(context)` throws an error with code
`FORWARD_PROXY_CONFIG_ERROR` when `FORWARD_PROXY` is missing or invalid. The
message includes the consumer context but never exposes unrelated secrets.

`buildForwardProxyUrl(targetUrl, options)` URL-encodes the target and appends
optional query parameters such as forwarded headers. It supports the deployment
format ending in `?url=` and the equivalent `{url}` placeholder form.

## Integration

### CB01

Remove the embedded `CB01_FORWARD_PROXY` default and legacy forward-proxy env
lookups. CB01 forward-only requests call the shared URL builder. When the proxy
is required but not configured, the request fails explicitly.

### Uprot

Remove `UPROT_FORWARD_PROXY_DEFAULT` and legacy env lookup chains. Explicit
per-call `uprotForwardProxy: 'false'` remains supported for tests and flows that
intentionally disable forward wrapping. Otherwise Uprot reads the shared
`FORWARD_PROXY` authority and raises the configuration error when wrapping is
required.

### Mediaflow Gateway

Forward URL construction accepts an explicit per-call override when supplied by
code, but runtime environment selection reads only `FORWARD_PROXY`. Legacy
environment aliases are removed.

### CinemaCity

Remove the embedded specialized `/cinemacity/fetch?d=` endpoint. CinemaCity
document forwarding uses the shared generic forward-proxy URL builder and
retains its forwarded header parameters. Extractor host derivation continues to
derive the origin from the configured `FORWARD_PROXY` URL.

## Deployment Configuration

`.env.example` documents the single required variable. `docker-compose.yml`
passes only:

```yaml
FORWARD_PROXY: "${FORWARD_PROXY:-}"
```

Legacy forward-proxy variables are removed from the Compose environment list.
Provider enable flags and timeouts remain separate because they control
behavior, not endpoint identity.

## Error Handling

- Missing `FORWARD_PROXY`: throw `FORWARD_PROXY_CONFIG_ERROR` when a required
  forward-proxy flow starts.
- Invalid `FORWARD_PROXY`: throw `FORWARD_PROXY_CONFIG_ERROR`.
- Invalid target URL: throw `FORWARD_PROXY_CONFIG_ERROR`.
- Intentional disabled mode: return the original direct URL only where a caller
  explicitly opts out, such as `uprotForwardProxy: 'false'`.

## Testing

Add focused tests for:

- shared helper reads `FORWARD_PROXY`, encodes targets, and appends header
  parameters;
- shared helper throws for missing and invalid configuration;
- CB01 reads only `FORWARD_PROXY`;
- Uprot uses `FORWARD_PROXY` and no embedded fallback;
- Mediaflow forward URL construction uses `FORWARD_PROXY`;
- CinemaCity uses the generic configured endpoint and derives its extractor
  base from that endpoint;
- source scan contains no production embedded Kraken forward URL.

Run targeted tests first, then the complete `npm test` suite.
