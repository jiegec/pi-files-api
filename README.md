# pi-files-api

[![CI](https://github.com/jiegec/pi-files-api/actions/workflows/ci.yml/badge.svg)](https://github.com/jiegec/pi-files-api/actions/workflows/ci.yml)

A single-file [pi](https://github.com/earendil-works/pi) extension that stops embedding images as inline base64 in provider requests. Instead it uploads each image once to a **Files API** (OpenAI- or Anthropic-shaped) and references it by `file_id`.

This is useful for vision models behind OpenAI-/Anthropic-compatible endpoints (for example DeepSeek's `POST /files` and `POST /anthropic/v1/files`) where referencing by file id avoids resending large base64 payloads on every turn and lifts the inline request-size limits.

## How it works

The extension hooks `before_provider_request`, walks the outgoing payload, finds base64 `data:` images, uploads each unique image (multipart), then rewrites the block in place:

| API | Before | After |
| --- | --- | --- |
| `openai-completions` | `{ "type": "image_url", "image_url": { "url": "data:…" } }` | `{ "type": "file", "file_id": "file-api-…" }` |
| `openai-responses` | `{ "type": "input_image", "detail": "auto", "image_url": "data:…" }` | `{ "type": "input_image", "file_id": "file-api-…" }` |
| `anthropic-messages` | `{ "type": "image", "source": { "type": "base64", "media_type": "image/jpeg", "data": "…" } }` | `{ "type": "image", "source": { "type": "file", "file_id": "file-api-…" } }` |

Supported APIs: `openai-completions`, `openai-responses`, and `anthropic-messages`. Inline `http(s)` image URLs are left untouched.

The Files API flavor follows the request API: OpenAI-shaped (`POST <baseUrl>/files`) for `openai-*`, Anthropic-shaped (`POST <baseUrl>/v1/files`) for `anthropic-messages`. With `authProvider` the upload borrows that provider's endpoint and credentials, so the flavor follows **that** provider's API instead — for example an `anthropic-messages` request to one gateway can upload through DeepSeek's OpenAI-shaped Files API. Override it explicitly with the `api` option. When an Anthropic payload is rewritten, `files-api-2025-04-14` is added to the `anthropic-beta` header, which the Messages API requires when referencing a Files API id.

Uploads are deduplicated by a SHA-256 hash of the image bytes (in memory and, optionally, on disk) and by endpoint, flavor, and credentials, so the same image is uploaded once per session at most. The `file_id` is stable across turns, which keeps prompt prefixes stable.

## Install / run

The extension is not packaged. Load it directly (pi uses `jiti`, so no build step is needed):

```bash
npx @earendil-works/pi-coding-agent --extension ./files-api.ts
```

To load it automatically in every session, copy `files-api.ts` into the pi agent extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions
cp files-api.ts ~/.pi/agent/extensions/
```

pi auto-loads every extension in that directory, so no `--extension` flag is needed.

## Configuration

Configuration is read from the pi agent `models.json` (`<agent-dir>/models.json`, normally `~/.pi/agent/models.json`). It is **opt-in**: without a `filesApi` entry the extension does nothing.

A `filesApi` entry can be placed on the provider, on a specific model, or in `modelOverrides` (model definition > model override > provider).

```jsonc
{
  "providers": {
    "my-provider": {
      "baseUrl": "https://api.example.com/v1",
      "api": "openai-responses",
      "apiKey": "…",
      "filesApi": {
        "enabled": true,
        "baseUrl": "https://api.deepseek.com",
        "api": "openai",
        "authProvider": "deepseek",
        "apiKey": "$MY_FILES_KEY",
        "purpose": "user_data",
        "expiresAfterSeconds": 604800,
        "cache": true
      },
      "models": [
        { "id": "vision-model", "filesApi": true },
        { "id": "text-only-model", "filesApi": false }
      ]
    }
  }
}
```

### Options

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` when the entry exists | Enable the rewrite. |
| `baseUrl` | string | the `authProvider`'s base URL when set, else the active model's `baseUrl` | Files API base: endpoint `<baseUrl>/files` (openai) or `<baseUrl>/v1/files` (anthropic). |
| `api` | `"openai"` \| `"anthropic"` | the `authProvider`'s API when set, else the request API | Files API flavor and upload shape. |
| `authProvider` | string | — | Use **another provider's** credentials: API key and headers, plus that provider's base URL unless `baseUrl` is set. |
| `apiKey` | string | — | Override just the API key. Literal, `$ENV_VAR`, or `${ENV_VAR}`. Replaces any inherited auth header. |
| `purpose` | string | `user_data` (`vision` for provider `openai`) | Multipart `purpose` field (openai flavor only). |
| `expiresAfterSeconds` | number \| null | `604800` (7 days) | File lifetime. The openai flavor sends `expires_after[anchor]=created_at` + `expires_after[seconds]=<n>`; the anthropic flavor sends `expires_in_seconds` (clamped to the allowed 3600..7776000). `null` uploads without an expiry. |
| `cache` | boolean | `true` | Persist `hash -> file_id` to disk across sessions. |

`"filesApi": true` enables with defaults; `"filesApi": false` disables.

### Auth override examples

Upload to DeepSeek's Files API using your DeepSeek credentials while chatting through another provider:

```jsonc
"filesApi": {
  "enabled": true,
  "baseUrl": "https://api.deepseek.com",
  "authProvider": "deepseek"
}
```

Keep the active provider's endpoint but use a different key (a literal, or an environment variable):

```jsonc
"filesApi": { "enabled": true, "apiKey": "$MY_FILES_KEY" }
```

`authProvider` needs the referenced provider to have usable credentials configured in pi (via `/login`, `auth.json`, its environment variable, or `apiKey` in `models.json`). `getProviderAuth()` returns nothing when the provider is unconfigured, and the upload is skipped.

The upload authenticates with `Authorization: Bearer <key>` for the openai flavor and `x-api-key: <key>` for the anthropic flavor (plus `anthropic-version` and the `anthropic-beta: files-api-2025-04-14` header). The anthropic flavor sets expiry with the multipart `expires_in_seconds` field.

## CLI flags

| Flag | Description |
| --- | --- |
| `--files-api` | Force-enable without a `models.json` entry, using the current provider's auth. |
| `--files-api-purpose <p>` | Override the multipart `purpose`. |
| `--files-api-base-url <url>` | Override the Files API base URL. |

The flavor is inferred from the request API; there is no flag for it (set `filesApi.api` in `models.json` instead).

```bash
npx @earendil-works/pi-coding-agent \
  --extension ./files-api.ts \
  --files-api --files-api-base-url https://api.deepseek.com
```

## Command

| Command | Description |
| --- | --- |
| `/files-api` | Status (endpoint, auth, purpose, expiry) + stats. |
| `/files-api stats` | Counters only. |
| `/files-api clear` | Drop the in-memory and on-disk `file_id` cache. |
| `/files-api retry` | Reset the upload backoff. |
| `/files-api help` | List subcommands. |

Statistics include images seen, blocks transformed, uploads (count and bytes), cache hits, failures, skipped-due-to-backoff, expired-dropped, in-flight uploads, memory/disk `file_id` counts, the last upload time/file id, and the last error.

## Behavior and safety

- **Logging:** each image block is reported as it is resolved — `uploaded (<size>) <file_id>` for a fresh upload, `reused <file_id>` for a memory/disk cache hit — as a dim line in the transcript (a custom entry, not sent to the model), or on stderr outside the TUI. It is not a popup notification. A `file_id` referenced several times in one request logs once.
- **Fallback:** if an upload fails, the inline image is kept so the request still has a chance to succeed. Failures are surfaced via a TUI warning (or stderr outside the TUI) and recorded for `/files-api`.
- **Backoff:** after 3 consecutive failures for an endpoint, further uploads to it are skipped for 5 minutes to avoid a failed round trip on every turn. Reset with `/files-api retry`.
- **Cache:** stored as `files-api-cache.json` in the agent directory, keyed by endpoint + credentials. Each entry remembers its expiry as an RFC 3339 UTC timestamp (the server's `expires_at`, otherwise the configured lifetime); expired entries are ignored and dropped, and the image is uploaded again next time. Clear it with `/files-api clear`.
- **Concurrency:** parallel requests deduplicate in-flight uploads for the same image.

## Requirements

- A provider that implements the configured Files API (`POST <baseUrl>/files` for openai, `POST <baseUrl>/v1/files` for anthropic), and a model that supports image input.
- Node 18+ (uses the global `fetch`, `FormData`, and `Blob`).

Some gateways advertise OpenAI-/Anthropic-compatible chat endpoints without implementing the Files API. In that case the upload returns e.g. `404 path not found: /v1/files`, and the extension falls back to inline images. Point `filesApi.baseUrl` at an endpoint that supports the Files API, or disable the extension for that provider.

## Tests

The suite needs no install or build step: Node 22 runs the TypeScript directly and a small loader stubs the pi package. From the repository root:

```bash
node --import ./test/register.mjs --test test/files-api.test.ts
```

It covers opt-in and config resolution, OpenAI/Anthropic payload rewrites, auth overrides, upload shape (`flavor`, `purpose`, `expires_after`), the in-memory and on-disk `file_id` cache, failure fallback, backoff, and the `/files-api` command.

## Files

- `files-api.ts` — the extension.
- `test/` — Node test runner suite and the pi package stub/loader.
- `files-api-cache.json` — persisted `hash -> file_id` cache (created at runtime in the agent directory).
