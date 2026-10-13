/**
 * pi-files-api
 *
 * Instead of embedding images as inline base64 in provider requests, upload each
 * image once to a Files API (OpenAI- or Anthropic-shaped) and reference it by its
 * `file_id`.
 *
 * Supported request APIs:
 *   - openai-completions:  {type:"image_url", image_url:{url:"data:..."}}
 *                          -> {type:"file", file_id:"file-api-..."}
 *   - openai-responses:    {type:"input_image", detail, image_url:"data:..."}
 *                          -> {type:"input_image", file_id:"file-api-..."}
 *   - anthropic-messages:  {type:"image", source:{type:"base64", media_type, data}}
 *                          -> {type:"image", source:{type:"file", file_id:"file-api-..."}}
 *
 * Configuration is read from the pi agent `models.json`
 * (`<agent-dir>/models.json`, normally `~/.pi/agent/models.json`).
 *
 * The base URL and whether the behaviour applies are taken from that file:
 *
 *   {
 *     "providers": {
 *       "my-provider": {
 *         "baseUrl": "https://api.example.com/v1",
 *         "api": "openai-responses",
 *         "filesApi": {                       // opt-in switch (provider, model, or modelOverrides)
 *           "enabled": true,
 *           "baseUrl": "https://api.deepseek.com", // optional endpoint override
 *           "api": "openai",                   // optional "openai" | "anthropic" flavor (default: authProvider's api, else the request api)
 *           "authProvider": "deepseek",       // optional: use another provider's credentials
 *           "apiKey": "$MY_FILES_KEY",        // optional literal/env API key override
 *           "purpose": "user_data",           // optional (default: user_data, vision for "openai")
 *           "expiresAfterSeconds": 604800,    // optional (default 604800; null keeps files forever)
 *           "cache": true                     // optional, persist hash -> file_id on disk
 *         },
 *         "models": [
 *           { "id": "vision-model", "filesApi": true } // optional model-level override
 *         ]
 *       }
 *     }
 *   }
 *
 * The Files API is opt-in: without a `filesApi` entry (or the `--files-api` flag)
 * it does nothing. `authProvider` uploads with another provider's credentials
 * (API key, headers, and, unless overridden, its base URL) and infers the Files API
 * flavor from that provider's API, so an Anthropic request can upload to an
 * OpenAI-shaped Files API; `apiKey` overrides just the key (a literal or
 * `$ENV_VAR` / `${ENV_VAR}`).
 *
 * Each upload is logged as a dim line in the transcript (a custom entry, not sent
 * to the model; stderr outside the TUI): `uploaded [<name>] (<size>) <file_id>`.
 * Reuses stay silent; a failure is reported as a warning. For images read through
 * a tool (e.g. `read`), the source file name is appended when known.
 *
 * Usage:
 *   npx @earendil-works/pi-coding-agent --extension ./files-api.ts
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Default lifetime for uploaded files (7 days). */
const DEFAULT_EXPIRES_AFTER_SECONDS = 604800;
const CACHE_VERSION = 4;
const CACHE_FILE = "files-api-cache.json";
/** APIs whose payload we know how to rewrite. */
const COMPLETIONS_API = "openai-completions";
const RESPONSES_API = "openai-responses";
const ANTHROPIC_API = "anthropic-messages";
/** Required when the Anthropic Messages API references a Files API id. */
const FILES_API_BETA = "files-api-2025-04-14";
/** Anthropic `expires_in_seconds` bounds (1 hour .. 90 days). */
const ANTHROPIC_MIN_EXPIRES_SECONDS = 3_600;
const ANTHROPIC_MAX_EXPIRES_SECONDS = 7_776_000;

/** Files API flavor: OpenAI-shaped (`/files`) or Anthropic-shaped (`/v1/files`). */
type FilesApiFlavor = "openai" | "anthropic";

/** Custom session entry type for the per-image upload log. */
const LOG_ENTRY_TYPE = "files-api-log";

/** Report an image upload (`name` is the source file, when known). */
type UploadLogger = (info: { id: string; name?: string; bytes: number }) => void;

interface FilesApiEntryConfig {
	enabled?: boolean;
	baseUrl?: string;
	/**
	 * Files API flavor. Defaults to the `authProvider`'s API shape when one is set,
	 * otherwise to anthropic for `anthropic-messages` and openai for the rest.
	 */
	api?: FilesApiFlavor;
	/** Use another provider's credentials for the upload. */
	authProvider?: string;
	/** Override just the API key (literal or `$ENV_VAR` / `${ENV_VAR}`). */
	apiKey?: string;
	purpose?: string;
	cache?: boolean;
	/** Seconds until the file expires. `null` keeps files permanently. */
	expiresAfterSeconds?: number | null;
}

interface ResolvedConfig {
	enabled: boolean;
	source: "models.json" | "default" | "flag";
	baseUrl?: string;
	api?: FilesApiFlavor;
	authProvider?: string;
	apiKey?: string;
	purpose: string;
	cache: boolean;
	expiresAfterSeconds: number | null;
}

interface CachedFile {
	id: string;
	/** RFC 3339 UTC timestamp at which the file expires; undefined means it never expires. */
	expiresAt?: string;
}

interface CacheEntry extends CachedFile {
	/** Files API endpoint the file belongs to. */
	endpoint: string;
	createdAt: string;
}

interface CacheFile {
	version: number;
	entries: Record<string, CacheEntry>;
}

interface RuntimeState {
	/** Images encountered in provider payloads. */
	imagesSeen: number;
	/** Image blocks replaced with file references. */
	transformed: number;
	/** Successful Files API uploads. */
	uploaded: number;
	/** Images served from the in-memory or on-disk file_id cache. */
	cacheHits: number;
	/** Failed uploads (the inline image is kept). */
	failures: number;
	/** Images left inline because the endpoint is in backoff. */
	skipped: number;
	/** Expired cached entries that were dropped. */
	expired: number;
	/** Total bytes sent to the Files API. */
	bytesUploaded: number;
	lastUploadAt: number | undefined;
	lastFileId: string | undefined;
	lastError: string | undefined;
	memory: Map<string, CachedFile>;
	inflight: Map<string, Promise<string | undefined>>;
	/** Consecutive failures per endpoint, for backoff. */
	failureCounts: Map<string, number>;
	/** Endpoint -> epoch ms until which uploads are skipped. */
	backoffUntil: Map<string, number>;
}

function newState(): RuntimeState {
	return {
		imagesSeen: 0,
		transformed: 0,
		uploaded: 0,
		cacheHits: 0,
		failures: 0,
		skipped: 0,
		expired: 0,
		bytesUploaded: 0,
		lastUploadAt: undefined,
		lastFileId: undefined,
		lastError: undefined,
		memory: new Map(),
		inflight: new Map(),
		failureCounts: new Map(),
		backoffUntil: new Map(),
	};
}

// ---------------------------------------------------------------------------
// models.json
// ---------------------------------------------------------------------------

/** The subset of `models.json` this extension reads. */
interface ModelsJson {
	providers?: Record<string, ModelsJsonProvider>;
}

interface ModelsJsonProvider {
	/** Chat API all the provider's models speak, e.g. `openai-completions`. */
	api?: string;
	filesApi?: boolean | FilesApiEntryConfig;
	models?: Array<{ id?: string; api?: string; filesApi?: boolean | FilesApiEntryConfig }>;
	modelOverrides?: Record<string, { filesApi?: boolean | FilesApiEntryConfig }>;
}

let modelsJsonCache: { path: string; mtimeMs: number; raw: ModelsJson } | undefined;

function readModelsJson(): ModelsJson | undefined {
	const path = join(getAgentDir(), "models.json");
	try {
		const stat = statSync(path);
		if (modelsJsonCache && modelsJsonCache.path === path && modelsJsonCache.mtimeMs === stat.mtimeMs) {
			return modelsJsonCache.raw;
		}
		const raw = JSON.parse(readFileSync(path, "utf8")) as ModelsJson;
		modelsJsonCache = { path, mtimeMs: stat.mtimeMs, raw };
		return raw;
	} catch {
		return undefined;
	}
}

function defaultPurpose(provider: string): string {
	return provider === "openai" ? "vision" : "user_data";
}

/** Map a chat API name to a Files API flavor, or undefined when it is unknown. */
function flavorForApi(api: string | undefined): FilesApiFlavor | undefined {
	if (!api) return undefined;
	if (api.includes("anthropic")) return "anthropic";
	if (api.includes("openai") || api.includes("azure")) return "openai";
	return undefined;
}

/**
 * The chat API a provider's models speak: its models.json `api` (provider-level,
 * else the first model entry that sets one), falling back to the registry catalog.
 */
function providerApi(ctx: ExtensionContext, name: string): string | undefined {
	const entry = readModelsJson()?.providers?.[name];
	if (typeof entry?.api === "string" && entry.api.length > 0) return entry.api;
	const modelApi = entry?.models?.find((model) => typeof model.api === "string")?.api;
	if (typeof modelApi === "string" && modelApi.length > 0) return modelApi;
	return ctx.modelRegistry.getProvider(name)?.getModels?.()[0]?.api;
}

/**
 * Pick the Files API flavor (upload shape, URL path, and auth header). An explicit
 * `filesApi.api` wins. With `authProvider` the upload borrows that provider's
 * endpoint and credentials, so follow *its* API shape even when the active request
 * API differs (e.g. an Anthropic request uploaded to an OpenAI-shaped Files API).
 * Otherwise follow the request API.
 */
function resolveFlavor(ctx: ExtensionContext, config: ResolvedConfig, requestApi: string): FilesApiFlavor {
	if (config.api) return config.api;
	if (config.authProvider) {
		const inferred = flavorForApi(providerApi(ctx, config.authProvider));
		if (inferred) return inferred;
	}
	return requestApi === ANTHROPIC_API ? "anthropic" : "openai";
}

/** Files API base URL the upload targets (borrowing the auth provider's when set). */
function uploadBaseUrl(ctx: ExtensionContext, config: ResolvedConfig): string {
	const borrowed = config.authProvider ? ctx.modelRegistry.getProvider(config.authProvider)?.baseUrl : undefined;
	return (config.baseUrl ?? borrowed ?? ctx.model?.baseUrl ?? "unknown").replace(/\/+$/, "");
}

function normalizeExpires(value: unknown): number | null {
	if (value === null) return null;
	if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
	return DEFAULT_EXPIRES_AFTER_SECONDS;
}

/**
 * Resolve the files-api configuration for the active model. Precedence:
 * model definition > model override > provider, then CLI flags override all.
 */
function resolveConfig(pi: ExtensionAPI, model: { provider: string; id: string; api: string }): ResolvedConfig {
	const raw = readModelsJson();
	const provider = raw?.providers?.[model.provider];
	const modelDef = Array.isArray(provider?.models)
		? provider.models.find((entry: any) => entry && entry.id === model.id)
		: undefined;
	const override = provider?.modelOverrides?.[model.id];
	const entry = (modelDef?.filesApi ?? override?.filesApi ?? provider?.filesApi) as
		| boolean
		| FilesApiEntryConfig
		| undefined;

	let config: ResolvedConfig;
	if (entry === false) {
		config = {
			enabled: false,
			source: "models.json",
			purpose: defaultPurpose(model.provider),
			cache: true,
			expiresAfterSeconds: DEFAULT_EXPIRES_AFTER_SECONDS,
		};
	} else if (entry === true || (entry && typeof entry === "object")) {
		const obj = entry === true ? {} : entry;
		const authProvider =
			typeof obj.authProvider === "string" && obj.authProvider.length > 0 ? obj.authProvider : undefined;
		config = {
			enabled: obj.enabled !== false,
			source: "models.json",
			baseUrl: typeof obj.baseUrl === "string" && obj.baseUrl.length > 0 ? obj.baseUrl : undefined,
			api: obj.api === "openai" || obj.api === "anthropic" ? obj.api : undefined,
			authProvider,
			apiKey: typeof obj.apiKey === "string" && obj.apiKey.length > 0 ? obj.apiKey : undefined,
			purpose:
				typeof obj.purpose === "string" && obj.purpose.length > 0
					? obj.purpose
					: defaultPurpose(authProvider ?? model.provider),
			cache: obj.cache !== false,
			expiresAfterSeconds: normalizeExpires(obj.expiresAfterSeconds),
		};
	} else {
		// Opt-in: no config entry means disabled unless forced with --files-api.
		config = {
			enabled: false,
			source: "default",
			purpose: defaultPurpose(model.provider),
			cache: true,
			expiresAfterSeconds: DEFAULT_EXPIRES_AFTER_SECONDS,
		};
	}

	if (pi.getFlag("files-api") === true) {
		config.enabled = true;
		config.source = "flag";
	}
	const flagPurpose = pi.getFlag("files-api-purpose");
	if (typeof flagPurpose === "string" && flagPurpose.length > 0) config.purpose = flagPurpose;
	const flagBaseUrl = pi.getFlag("files-api-base-url");
	if (typeof flagBaseUrl === "string" && flagBaseUrl.length > 0) config.baseUrl = flagBaseUrl;

	return config;
}

// ---------------------------------------------------------------------------
// Persistent hash -> file_id cache
// ---------------------------------------------------------------------------

let fileCache: CacheFile | undefined;

/**
 * SHA-256 of image bytes -> source file name, learned from tool results (the
 * `read` tool carries the path). Used to label uploads; cleared per session.
 */
const imageNames = new Map<string, string>();

function cachePath(): string {
	return join(getAgentDir(), CACHE_FILE);
}

function isExpired(entry: CachedFile, now = Date.now()): boolean {
	if (entry.expiresAt === undefined) return false;
	const expiresAtMs = Date.parse(entry.expiresAt);
	return Number.isFinite(expiresAtMs) && expiresAtMs <= now;
}

/** Drop expired entries from the loaded cache. Returns how many were removed. */
function pruneExpiredFileCache(): number {
	if (!fileCache) return 0;
	const now = Date.now();
	let removed = 0;
	for (const [key, entry] of Object.entries(fileCache.entries)) {
		if (isExpired(entry, now)) {
			delete fileCache.entries[key];
			removed += 1;
		}
	}
	return removed;
}

/** Remove one entry from the on-disk cache, saving only if it was present. */
function dropDiskEntry(key: string): void {
	const cache = loadFileCache();
	if (cache.entries[key]) {
		delete cache.entries[key];
		saveFileCache();
	}
}

function loadFileCache(): CacheFile {
	if (fileCache) return fileCache;
	let loaded: CacheFile | undefined;
	try {
		const parsed = JSON.parse(readFileSync(cachePath(), "utf8")) as CacheFile;
		if (parsed && parsed.version === CACHE_VERSION && parsed.entries && typeof parsed.entries === "object") {
			loaded = parsed;
		}
	} catch {
		// Missing or invalid cache: start fresh.
	}
	fileCache = loaded ?? { version: CACHE_VERSION, entries: {} };
	if (pruneExpiredFileCache() > 0) saveFileCache();
	return fileCache;
}

function saveFileCache(): void {
	if (!fileCache) return;
	try {
		const path = cachePath();
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, JSON.stringify(fileCache, null, 2));
		renameSync(tmp, path);
	} catch {
		// Caching is best-effort; never fail a request over it.
	}
}

// ---------------------------------------------------------------------------
// Files API upload
// ---------------------------------------------------------------------------

interface DataUriImage {
	mimeType: string;
	bytes: Buffer;
}

const DATA_URI_RE = /^data:([^;,]*)(;base64)?,([\s\S]*)$/;

function parseDataUri(uri: string): DataUriImage | undefined {
	const match = DATA_URI_RE.exec(uri);
	if (!match) return undefined;
	if (match[2] !== ";base64") return undefined;
	const mimeType = match[1] || "application/octet-stream";
	return { mimeType, bytes: Buffer.from(match[3], "base64") };
}

function extensionFor(mimeType: string): string {
	switch (mimeType) {
		case "image/jpeg":
			return "jpg";
		case "image/png":
			return "png";
		case "image/gif":
			return "gif";
		case "image/webp":
			return "webp";
		default:
			return "bin";
	}
}

function hasAuthHeader(headers: Record<string, string>): boolean {
	return hasHeader(headers, "authorization") || hasHeader(headers, "x-api-key") || hasHeader(headers, "api-key");
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
	const lower = name.toLowerCase();
	return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Append a beta feature to an `anthropic-beta` header value. */
function addBetaHeader(headers: Record<string, string>, beta: string): void {
	const key = Object.keys(headers).find((name) => name.toLowerCase() === "anthropic-beta");
	if (!key) {
		headers["anthropic-beta"] = beta;
		return;
	}
	const parts = (headers[key] ?? "")
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	if (!parts.includes(beta)) parts.push(beta);
	headers[key] = parts.join(",");
}

/** Add a beta feature to an Anthropic messages payload (pi turns `betas` into the header). */
function addPayloadBeta(payload: Record<string, any>, beta: string): void {
	const current = payload.betas;
	if (Array.isArray(current)) {
		if (!current.includes(beta)) current.push(beta);
	} else if (typeof current === "string" && current.length > 0) {
		const parts = current.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
		if (!parts.includes(beta)) parts.push(beta);
		payload.betas = parts;
	} else {
		payload.betas = [beta];
	}
}

/**
 * Parse a Files API `expires_at`: Unix seconds for the OpenAI flavor, an RFC 3339
 * string for the Anthropic flavor. Returns an RFC 3339 UTC timestamp, or undefined.
 */
function parseExpiresAt(value: unknown): string | undefined {
	let ms: number | undefined;
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		ms = Math.floor(value) * 1000;
	} else if (typeof value === "string" && value.length > 0) {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) ms = parsed;
	}
	return ms === undefined ? undefined : new Date(ms).toISOString();
}

/** Expand a `$ENV_VAR` / `${ENV_VAR}` config value; otherwise return it verbatim. */
function resolveApiKey(value: string): string {
	const match = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(value.trim());
	if (match) return process.env[match[1]] ?? value;
	return value;
}

interface UploadResult {
	id: string;
	expiresAt?: string;
}

async function uploadToFilesApi(
	image: DataUriImage,
	hash: string,
	ctx: ExtensionContext,
	config: ResolvedConfig,
	flavor: FilesApiFlavor,
	name?: string,
): Promise<UploadResult> {
	const model = ctx.model;
	if (!model) throw new Error("no active model");

	let apiKey: string | undefined;
	let rawHeaders: Record<string, unknown>;
	let baseUrl: string | undefined;

	if (config.authProvider) {
		// Reuse another provider's credentials (and, unless overridden, its base URL).
		const authResult = await ctx.modelRegistry.getProviderAuth(config.authProvider);
		if (!authResult) throw new Error(`no credentials found for auth provider "${config.authProvider}"`);
		apiKey = authResult.auth.apiKey;
		rawHeaders = authResult.auth.headers ?? {};
		baseUrl =
			config.baseUrl ??
			authResult.auth.baseUrl ??
			uploadBaseUrl(ctx, config);
	} else {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) throw new Error(auth.error);
		apiKey = auth.apiKey;
		rawHeaders = auth.headers ?? {};
		baseUrl = config.baseUrl ?? auth.baseUrl ?? model.baseUrl;
	}

	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(rawHeaders)) {
		if (typeof value === "string") headers[key] = value;
	}

	if (config.apiKey) {
		// An explicit key wins over any inherited auth header.
		apiKey = resolveApiKey(config.apiKey);
		for (const key of Object.keys(headers)) {
			const lower = key.toLowerCase();
			if (lower === "authorization" || lower === "x-api-key" || lower === "api-key") delete headers[key];
		}
	}
	const base = (baseUrl ?? model.baseUrl).replace(/\/+$/, "");
	const form = new FormData();
	form.append(
		"file",
		new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }),
		name ?? `image-${hash.slice(0, 12)}.${extensionFor(image.mimeType)}`,
	);

	// Both flavors expire files at upload time, but with different form fields and
	// ranges. Anthropic only accepts 1 hour..90 days, so clamp to stay valid.
	const expiresSeconds =
		config.expiresAfterSeconds === null
			? null
			: flavor === "anthropic"
				? Math.min(
						ANTHROPIC_MAX_EXPIRES_SECONDS,
						Math.max(ANTHROPIC_MIN_EXPIRES_SECONDS, Math.floor(config.expiresAfterSeconds)),
					)
				: Math.floor(config.expiresAfterSeconds);

	let url: string;
	if (flavor === "anthropic") {
		// Anthropic-shaped Files API: /v1/files, x-api-key, and the files beta header.
		url = `${base}/v1/files`;
		if (!hasHeader(headers, "anthropic-version")) headers["anthropic-version"] = "2023-06-01";
		addBetaHeader(headers, FILES_API_BETA);
		if (!hasAuthHeader(headers) && apiKey) headers["x-api-key"] = apiKey;
		if (expiresSeconds !== null) form.append("expires_in_seconds", String(expiresSeconds));
	} else {
		url = `${base}/files`;
		form.append("purpose", config.purpose);
		if (expiresSeconds !== null) {
			// DeepSeek's OpenAI-compatible Files API takes nested form fields.
			form.append("expires_after[anchor]", "created_at");
			form.append("expires_after[seconds]", String(expiresSeconds));
		}
		if (!hasAuthHeader(headers) && apiKey) headers.Authorization = `Bearer ${apiKey}`;
	}

	const response = await fetch(url, {
		method: "POST",
		headers,
		body: form,
		signal: ctx.signal,
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`POST ${url} failed (${response.status}): ${body.slice(0, 400)}`);
	}
	const data = (await response.json().catch(() => undefined)) as
		| { id?: unknown; expires_at?: unknown }
		| undefined;
	if (!data || typeof data.id !== "string" || data.id.length === 0) {
		throw new Error(`POST ${url} returned no file id`);
	}

	// Prefer the server's expiry; fall back to the lifetime we requested.
	let expiresAt = parseExpiresAt(data.expires_at);
	if (expiresAt === undefined && expiresSeconds !== null) {
		expiresAt = new Date(Date.now() + expiresSeconds * 1000).toISOString();
	}
	return { id: data.id, expiresAt };
}

async function uploadImage(
	dataUri: string,
	ctx: ExtensionContext,
	config: ResolvedConfig,
	state: RuntimeState,
	flavor: FilesApiFlavor,
	log: UploadLogger,
): Promise<string | undefined> {
	const image = parseDataUri(dataUri);
	if (!image || !image.mimeType.startsWith("image/") || image.bytes.length === 0) return undefined;

	const hash = createHash("sha256").update(image.bytes).digest("hex");
	// Key by endpoint + auth scope + flavor so changing any of them re-uploads
	// instead of reusing a file id that belongs to a different Files API.
	const endpoint = uploadBaseUrl(ctx, config);
	const scopeKey = `${config.authProvider ?? "self"}|${flavor}|${endpoint}`;
	const key = `${scopeKey}:${hash}`;

	// A cached file_id is always reusable, even while the endpoint is in backoff.
	// Expired entries are ignored and dropped so the image is uploaded again.
	const inMemory = state.memory.get(key);
	if (inMemory) {
		if (!isExpired(inMemory)) {
			state.cacheHits += 1;
			return inMemory.id;
		}
		// Expired: drop it from memory and disk, then re-upload below.
		state.memory.delete(key);
		if (config.cache) dropDiskEntry(key);
		state.expired += 1;
	}
	if (config.cache) {
		const cached = loadFileCache().entries[key];
		if (cached) {
			if (!isExpired(cached)) {
				state.memory.set(key, { id: cached.id, expiresAt: cached.expiresAt });
				state.cacheHits += 1;
				return cached.id;
			}
			dropDiskEntry(key);
			state.expired += 1;
		}
	}

	// After repeated failures (for example an endpoint without a Files API),
	// stop retrying for a while so every turn does not pay the round trip.
	const backoff = state.backoffUntil.get(scopeKey);
	if (backoff && backoff > Date.now()) {
		state.skipped += 1;
		return undefined;
	}

	const inflight = state.inflight.get(key);
	if (inflight) return inflight;

	const name = imageNames.get(hash);
	const promise = uploadToFilesApi(image, hash, ctx, config, flavor, name)
		.then(({ id, expiresAt }) => {
			state.memory.set(key, { id, expiresAt });
			state.uploaded += 1;
			state.bytesUploaded += image.bytes.length;
			state.lastUploadAt = Date.now();
			state.lastFileId = id;
			state.failureCounts.delete(scopeKey);
			state.backoffUntil.delete(scopeKey);
			log({ id, name, bytes: image.bytes.length });
			if (config.cache) {
				loadFileCache().entries[key] = {
					id,
					endpoint,
					createdAt: new Date().toISOString(),
					expiresAt,
				};
				saveFileCache();
			}
			return id;
		})
		.catch((error) => {
			state.failures += 1;
			state.lastError = formatError(error);
			const count = (state.failureCounts.get(scopeKey) ?? 0) + 1;
			state.failureCounts.set(scopeKey, count);
			if (count >= 3 && !state.backoffUntil.has(scopeKey)) {
				state.backoffUntil.set(scopeKey, Date.now() + 5 * 60_000);
			}
			// Keep the inline image so the request still has a chance to succeed.
			if (ctx.mode === "tui") {
				ctx.ui.notify(`files-api upload failed: ${state.lastError}`, "warning");
			} else {
				console.error(`[files-api] upload failed: ${state.lastError}`);
			}
			return undefined;
		})
		.finally(() => {
			state.inflight.delete(key);
		});

	state.inflight.set(key, promise);
	return promise;
}

// ---------------------------------------------------------------------------
// Payload rewriting
// ---------------------------------------------------------------------------

/**
 * Recursively replace inline base64 image blocks with Files API `file` references.
 * Handles OpenAI-compatible and Anthropic payloads.
 */
async function rewriteImages(
	node: unknown,
	api: string,
	upload: (dataUri: string) => Promise<string | undefined>,
): Promise<void> {
	if (Array.isArray(node)) {
		for (const item of node) await rewriteImages(item, api, upload);
		return;
	}
	if (!node || typeof node !== "object") return;

	const record = node as Record<string, any>;

	if (api === COMPLETIONS_API) {
		if (
			record.type === "image_url" &&
			record.image_url &&
			typeof record.image_url.url === "string" &&
			record.image_url.url.startsWith("data:")
		) {
			const id = await upload(record.image_url.url);
			if (id) {
				record.type = "file";
				record.file_id = id;
				delete record.image_url;
			}
		}
	} else if (api === ANTHROPIC_API) {
		const source = record.source;
		if (
			record.type === "image" &&
			source &&
			typeof source === "object" &&
			source.type === "base64" &&
			typeof source.data === "string"
		) {
			const mimeType =
				typeof source.media_type === "string" && source.media_type.length > 0
					? source.media_type
					: "image/png";
			const id = await upload(`data:${mimeType};base64,${source.data}`);
			if (id) record.source = { type: "file", file_id: id };
		}
	} else if (
		record.type === "input_image" &&
		typeof record.image_url === "string" &&
		record.image_url.startsWith("data:")
	) {
		const id = await upload(record.image_url);
		if (id) {
			record.file_id = id;
			delete record.image_url;
			delete record.detail;
		}
	}

	for (const value of Object.values(record)) {
		await rewriteImages(value, api, upload);
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let state: RuntimeState = newState();

	pi.registerFlag("files-api", {
		description: "Force-upload images to the provider Files API and reference them by file id",
		type: "boolean",
	});
	pi.registerFlag("files-api-purpose", {
		description: "Files API upload purpose (default: user_data, or vision for the openai provider)",
		type: "string",
	});
	pi.registerFlag("files-api-base-url", {
		description: "Override the Files API base URL (<baseUrl>/files, or <baseUrl>/v1/files for Anthropic)",
		type: "string",
	});

	// Render each image resolution as a dim line in the transcript ("under" the
	// image) instead of a notification that can pop up while you are doing
	// something else. Entries are not sent to the model.
	pi.registerEntryRenderer<{ detail: string; id: string }>(LOG_ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		const line = data ? `files-api: ${data.detail} ${data.id}` : "files-api: image resolved";
		return {
			render: () => [theme.fg("dim", line)],
			invalidate: () => {},
		};
	});

	pi.on("session_start", () => {
		state = newState();
		fileCache = undefined;
		imageNames.clear();
	});

	// Learn source file names from tool results (the `read` tool carries the
	// path), keyed by image bytes so we can label the matching upload.
	pi.on("tool_result", (event) => {
		const input = event.input as Record<string, unknown>;
		const path = [input.path, input.file_path, input.filePath, input.filename, input.file].find(
			(value): value is string => typeof value === "string" && value.length > 0,
		);
		if (!path) return;
		const name = basename(path);
		for (const block of event.content) {
			if (block.type !== "image") continue;
			const hash = createHash("sha256").update(Buffer.from(block.data, "base64")).digest("hex");
			// Keyed by content, so identical bytes from different files share an entry;
			// keep the first name we see for a stable label.
			if (!imageNames.has(hash)) imageNames.set(hash, name);
		}
	});

	pi.on("before_provider_request", async (event, ctx) => {
		const model = ctx.model;
		if (!model) return;
		const api = model.api;
		const isCompletions = api === COMPLETIONS_API;
		const isAnthropic = api === ANTHROPIC_API;
		if (!isCompletions && !isAnthropic && api !== RESPONSES_API) return;

		const config = resolveConfig(pi, model);
		if (!config.enabled) return;

		const payload = event.payload as Record<string, any> | undefined;
		if (!payload || typeof payload !== "object") return;

		// OpenAI-compatible and Anthropic payloads both carry messages; only the
		// Responses API uses `input`.
		const root = isCompletions || isAnthropic ? payload.messages : payload.input;
		if (!root) return;

		const flavor = resolveFlavor(ctx, config, api);
		let replacedInRequest = 0;
		// Print one line per actual upload (reuses stay silent), under the message
		// being sent. Image blocks carry no file name, so read-tool uploads use the
		// name learned from the tool result when available.
		const logUpload: UploadLogger = ({ id, name, bytes }) => {
			const detail = `uploaded${name ? ` ${name}` : ""} (${formatBytes(bytes)})`;
			if (ctx.mode === "tui") pi.appendEntry(LOG_ENTRY_TYPE, { detail, id });
			else console.error(`[files-api] ${detail} ${id}`);
		};
		await rewriteImages(root, api, async (dataUri) => {
			state.imagesSeen += 1;
			const id = await uploadImage(dataUri, ctx, config, state, flavor, logUpload);
			if (id) {
				state.transformed += 1;
				replacedInRequest += 1;
			}
			return id;
		});

		// The Anthropic Messages API needs the files beta when a file id is used.
		if (isAnthropic && replacedInRequest > 0) addPayloadBeta(payload, FILES_API_BETA);

		// The payload was mutated in place; hand it back explicitly so chained
		// handlers and the provider see the rewritten images.
		return payload;
	});

	pi.registerCommand("files-api", {
		description: "Show Files API status/stats (subcommands: stats, clear, retry, help)",
		handler: async (args, ctx) => {
			const subcommand = args.trim().toLowerCase();

			if (subcommand === "clear" || subcommand === "cache clear") {
				const diskEntries = loadFileCache().entries;
				const memoryOnly = [...state.memory.keys()].filter((key) => !diskEntries[key]).length;
				const removed = Object.keys(diskEntries).length + memoryOnly;
				state = newState();
				fileCache = { version: CACHE_VERSION, entries: {} };
				saveFileCache();
				ctx.ui.notify(
					`files-api cache cleared (${removed} file_id record${removed === 1 ? "" : "s"})`,
					"info",
				);
				return;
			}

			if (subcommand === "stats") {
				ctx.ui.notify(formatStats(ctx, pi, state), "info");
				return;
			}

			if (subcommand === "retry") {
				state.failureCounts.clear();
				state.backoffUntil.clear();
				ctx.ui.notify("files-api backoff reset; uploads will be retried", "info");
				return;
			}

			if (subcommand === "help") {
				ctx.ui.notify(
					[
						"/files-api          status + stats",
						"/files-api stats    counters only",
						"/files-api clear    drop the local file_id cache",
						"/files-api retry    reset upload backoff",
					].join("\n"),
					"info",
				);
				return;
			}

			// Default: status + stats together.
			ctx.ui.notify([formatStatus(ctx, pi), "", formatStats(ctx, pi, state)].join("\n"), "info");
		},
	});
}

function formatStatus(ctx: ExtensionContext, pi: ExtensionAPI): string {
	const model = ctx.model;
	if (!model) return "files-api: no active model";
	const config = resolveConfig(pi, model);
	const flavor = resolveFlavor(ctx, config, model.api);
	const base = uploadBaseUrl(ctx, config);
	const endpoint = flavor === "anthropic" ? `${base}/v1/files` : `${base}/files`;
	return [
		`files-api: ${config.enabled ? "enabled" : "disabled"} (source: ${config.source})`,
		`provider/model: ${model.provider}/${model.id}`,
		`api: ${model.api}`,
		`files api: ${flavor} (${endpoint})`,
		`auth: ${config.authProvider ? `provider:${config.authProvider}` : "current provider"}${
			config.apiKey ? " + apiKey override" : ""
		}`,
		`purpose: ${config.purpose}`,
		`expires_after: ${config.expiresAfterSeconds ?? "never"}${config.expiresAfterSeconds ? "s" : ""}`,
	].join("\n");
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatStats(ctx: ExtensionContext, pi: ExtensionAPI, state: RuntimeState): string {
	const model = ctx.model;
	const config = model ? resolveConfig(pi, model) : undefined;
	const cached = loadFileCache();
	const diskCount = Object.keys(cached.entries).length;
	const lines = [
		"files-api stats:",
		`images seen: ${state.imagesSeen}`,
		`transformed: ${state.transformed}`,
		`uploads: ${state.uploaded} (${formatBytes(state.bytesUploaded)})`,
		`cache hits: ${state.cacheHits}`,
		`failures: ${state.failures}`,
		`skipped (backoff): ${state.skipped}`,
		`expired dropped: ${state.expired}`,
		`in-flight: ${state.inflight.size}`,
		`file_ids: ${state.memory.size} memory / ${diskCount} disk`,
	];
	if (config && !config.cache) lines.push("disk cache: disabled");
	if (state.backoffUntil.size > 0) {
		for (const [endpoint, until] of state.backoffUntil) {
			lines.push(`backoff: ${endpoint} until ${new Date(until).toISOString()}`);
		}
	}
	if (state.lastUploadAt) lines.push(`last upload: ${new Date(state.lastUploadAt).toISOString()}`);
	if (state.lastFileId) lines.push(`last file id: ${state.lastFileId}`);
	if (state.lastError) lines.push(`last error: ${state.lastError}`);
	return lines.join("\n");
}
