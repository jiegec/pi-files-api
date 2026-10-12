# pi-files-api

A single-file [pi](https://github.com/earendil-works/pi) extension that stops embedding images as inline base64 in provider requests. Instead it uploads each image once to an OpenAI-compatible **Files API** and references it by `file_id`.

This is useful for vision models behind OpenAI-compatible endpoints (for example DeepSeek's `POST /files`) where referencing by file id avoids resending large base64 payloads on every turn and lifts the inline request-size limits.

## How it works

The extension hooks `before_provider_request`, walks the outgoing payload, finds base64 `data:` images, uploads each unique image with `POST <baseUrl>/files` (multipart), then rewrites the block in place:

| API | Before | After |
| --- | --- | --- |
| `openai-completions` | `{ "type": "image_url", "image_url": { "url": "data:…" } }` | `{ "type": "file", "file_id": "file-api-…" }` |
| `openai-responses` | `{ "type": "input_image", "detail": "auto", "image_url": "data:…" }` | `{ "type": "input_image", "file_id": "file-api-…" }` |

Supported APIs: `openai-completions` and `openai-responses`. Inline `http(s)` image URLs are left untouched.

Uploads are deduplicated by a SHA-256 hash of the image bytes (in memory and, optionally, on disk) and by endpoint, so the same image is uploaded once per session at most. The `file_id` is stable across turns, which keeps prompt prefixes stable.

## Install / run

The extension is not packaged. Load it directly (pi uses `jiti`, so no build step is needed):

```bash
npx @earendil-works/pi-coding-agent --extension ./files-api.ts
```

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
| `baseUrl` | string | active model's `baseUrl` | Files API base; the endpoint is `<baseUrl>/files`. |
| `authProvider` | string | — | Use **another provider's** credentials: API key and headers, plus that provider's base URL unless `baseUrl` is set. |
| `apiKey` | string | — | Override just the API key. Literal, `$ENV_VAR`, or `${ENV_VAR}`. Replaces any inherited auth header. |
| `purpose` | string | `user_data` (`vision` for provider `openai`) | Multipart `purpose` field. |
| `expiresAfterSeconds` | number \| null | `604800` (7 days) | Lifetime. Sent as `expires_after[anchor]=created_at` and `expires_after[seconds]=<n>`; `null` keeps files permanently. |
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

## CLI flags

| Flag | Description |
| --- | --- |
| `--files-api` | Force-enable without a `models.json` entry, using the current provider's auth. |
| `--files-api-purpose <p>` | Override the multipart `purpose`. |
| `--files-api-base-url <url>` | Override the Files API base URL. |

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

Statistics include images seen, blocks transformed, uploads (count and bytes), cache hits, failures, skipped-due-to-backoff, in-flight uploads, memory/disk `file_id` counts, the last upload time/file id, and the last error.

## Behavior and safety

- **Fallback:** if an upload fails, the inline image is kept so the request still has a chance to succeed. Failures are surfaced via a TUI warning (or stderr outside the TUI) and recorded for `/files-api`.
- **Backoff:** after 3 consecutive failures for an endpoint, further uploads to it are skipped for 5 minutes to avoid a failed round trip on every turn. Reset with `/files-api retry`.
- **Cache:** stored as `files-api-cache.json` in the agent directory. File ids belong to the endpoint + credentials, so the key includes the auth scope; clear it if you change credentials.
- **Concurrency:** parallel requests deduplicate in-flight uploads for the same image.

## Requirements

- A provider that implements an OpenAI-compatible Files API at `<baseUrl>/files`, and a model that supports image input.
- Node 18+ (uses the global `fetch`, `FormData`, and `Blob`).

Some gateways advertise OpenAI-compatible chat/responses endpoints without implementing `/files`. In that case the upload returns e.g. `404 path not found: /v1/files`, and the extension falls back to inline images. Point `filesApi.baseUrl` at an endpoint that supports the Files API, or disable the extension for that provider.

## Files

- `files-api.ts` — the extension.
- `files-api-cache.json` — persisted `hash -> file_id` cache (created at runtime in the agent directory).
