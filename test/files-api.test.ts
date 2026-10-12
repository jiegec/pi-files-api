import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pluginFactory from "../files-api.ts";

// ---------------------------------------------------------------------------
// fetch interception
// ---------------------------------------------------------------------------

interface RecordedCall {
	url: string;
	method: string | undefined;
	headers: Record<string, string>;
	form: Array<[string, string | { name: string; type: string; size: number }]>;
}

let calls: RecordedCall[] = [];
let fetchImpl: (url: string, init: any) => Promise<Response> = async () => fileResponse("file-default");

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init: any) => {
	calls.push(recordCall(url, init));
	return fetchImpl(url, init);
}) as typeof fetch;

function recordCall(url: string, init: any): RecordedCall {
	const form: RecordedCall["form"] = [];
	const body = init?.body;
	if (body && typeof body.entries === "function") {
		for (const [key, value] of body.entries()) {
			form.push([
				key,
				typeof value === "string"
					? value
					: { name: value.name, type: value.type, size: value.size },
			]);
		}
	}
	return { url: String(url), method: init?.method, headers: { ...(init?.headers ?? {}) }, form };
}

function fileResponse(id: string, expiresAtSeconds?: number): Response {
	const body: Record<string, unknown> = { id, object: "file" };
	if (expiresAtSeconds !== undefined) body.expires_at = expiresAtSeconds;
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function secondsFromNow(seconds: number): number {
	return Math.floor(Date.now() / 1000) + seconds;
}

interface CacheFileShape {
	entries: Record<string, { id: string; expiresAt?: string }>;
}

function readDiskCache(agentDir: string): CacheFileShape {
	return JSON.parse(readFileSync(join(agentDir, "files-api-cache.json"), "utf8"));
}

function errorResponse(status: number, body = "boom"): Response {
	return new Response(body, { status });
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

interface HarnessOptions {
	agentDir?: string;
	modelsJson?: unknown;
	model?: Record<string, unknown>;
	flags?: Record<string, boolean | string>;
	mode?: "tui" | "print";
	selfAuth?: unknown;
	providerAuth?: Record<string, unknown>;
	providers?: Record<string, unknown>;
}

async function harness(t: test.TestContext, options: HarnessOptions = {}) {
	const ownsDir = options.agentDir === undefined;
	const agentDir = options.agentDir ?? mkdtempSync(join(tmpdir(), "pi-files-api-test-"));
	if (options.modelsJson !== undefined) {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "models.json"), JSON.stringify(options.modelsJson, null, 2));
	}
	process.env.PI_FILES_API_AGENT_DIR = agentDir;

	const handlers: Record<string, Array<(...args: any[]) => any>> = {};
	const commands: Record<string, any> = {};
	const flags = { ...(options.flags ?? {}) };
	const notifications: Array<{ message: string; type: string | undefined }> = [];
	const pi = {
		on: (event: string, handler: (...args: any[]) => any) => {
			(handlers[event] ??= []).push(handler);
		},
		registerFlag: () => {},
		getFlag: (name: string) => flags[name],
		registerCommand: (name: string, definition: any) => {
			commands[name] = definition;
		},
	};

	const model = {
		provider: "test-provider",
		id: "vision",
		api: "openai-completions",
		baseUrl: "https://gateway.example/v1",
		...(options.model ?? {}),
	};
	const ctx = {
		mode: options.mode ?? "tui",
		model,
		modelRegistry: {
			getApiKeyAndHeaders: async () => options.selfAuth ?? { ok: true, apiKey: "self-key", headers: {} },
			getProviderAuth: async (provider: string) => (options.providerAuth ?? {})[provider],
			getProvider: (provider: string) => (options.providers ?? {})[provider],
		},
		signal: undefined,
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
		},
	};

	pluginFactory(pi);
	for (const handler of handlers["session_start"] ?? []) {
		await handler({ type: "session_start", reason: "startup" }, ctx);
	}

	calls = [];

	const h = {
		agentDir,
		ctx,
		model,
		notifications,
		get calls() {
			return calls;
		},
		setModel: (patch: Record<string, unknown>) => Object.assign(model, patch),
		setFlag: (name: string, value: boolean | string) => {
			flags[name] = value;
		},
		setFetch: (impl: (url: string, init: any) => Promise<Response>) => {
			fetchImpl = impl;
		},
		async emit(payload: any) {
			let current = payload;
			for (const handler of handlers["before_provider_request"] ?? []) {
				const result = await handler({ type: "before_provider_request", payload: current }, ctx);
				if (result !== undefined) current = result;
			}
			return current;
		},
		async command(args = "") {
			notifications.length = 0;
			await commands["files-api"].handler(args, ctx);
			return notifications.map((entry) => entry.message).join("\n");
		},
		cleanup() {
			rmSync(agentDir, { recursive: true, force: true });
		},
	};

	if (ownsDir) t.after(() => h.cleanup());
	return h;
}

// ---------------------------------------------------------------------------
// payload helpers
// ---------------------------------------------------------------------------

function png(label: string): string {
	return `data:image/png;base64,${Buffer.from(label).toString("base64")}`;
}

function jpeg(label: string): string {
	return `data:image/jpeg;base64,${Buffer.from(label).toString("base64")}`;
}

function completionsPayload(url: string): any {
	return {
		model: "m",
		messages: [
			{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url } }] },
		],
	};
}

function responsesPayload(url: string): any {
	return {
		model: "m",
		input: [{ role: "user", content: [{ type: "input_image", detail: "auto", image_url: url }] }],
	};
}

function anthropicPayload(data: string, mediaType = "image/png"): any {
	return {
		model: "m",
		max_tokens: 10,
		messages: [
			{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image", source: { type: "base64", media_type: mediaType, data } }] },
		],
	};
}

function providerConfig(filesApi: unknown, modelExtra: Record<string, unknown> = {}): unknown {
	return {
		providers: {
			"test-provider": {
				baseUrl: "https://gateway.example/v1",
				api: "openai-completions",
				apiKey: "k",
				filesApi,
				models: [{ id: "vision", input: ["text", "image"], ...modelExtra }],
			},
		},
	};
}

function formValue(call: RecordedCall, key: string): RecordedCall["form"][number][1] | undefined {
	return call.form.find(([name]) => name === key)?.[1];
}

// ---------------------------------------------------------------------------
// opt-in and configuration
// ---------------------------------------------------------------------------

test("does nothing without a filesApi entry", async (t) => {
	const h = await harness(t, { modelsJson: providerConfig(undefined) });
	const payload = completionsPayload(png("a"));
	await h.emit(payload);
	assert.equal(payload.messages[0].content[1].type, "image_url");
	assert.equal(h.calls.length, 0);
});

test("provider-level filesApi: true enables the rewrite", async (t) => {
	const h = await harness(t, { modelsJson: providerConfig(true) });
	h.setFetch(async () => fileResponse("file-1"));
	const payload = completionsPayload(png("a"));
	await h.emit(payload);
	assert.deepEqual(payload.messages[0].content[1], { type: "file", file_id: "file-1" });
	assert.equal(h.calls[0].url, "https://gateway.example/v1/files");
});

test("filesApi: false disables the provider unless a model overrides it", async (t) => {
	const h = await harness(t, { modelsJson: providerConfig(false) });
	const payload = completionsPayload(png("a"));
	await h.emit(payload);
	assert.equal(payload.messages[0].content[1].type, "image_url");
	assert.equal(h.calls.length, 0);
});

test("model-level filesApi overrides the provider entry", async (t) => {
	const h = await harness(t, {
		modelsJson: providerConfig(false, { filesApi: true }),
	});
	h.setFetch(async () => fileResponse("file-model"));
	const payload = completionsPayload(png("a"));
	await h.emit(payload);
	assert.deepEqual(payload.messages[0].content[1], { type: "file", file_id: "file-model" });
});

test("--files-api flag enables without a models.json entry", async (t) => {
	const h = await harness(t, { flags: { "files-api": true } });
	h.setFetch(async () => fileResponse("file-flag"));
	const payload = completionsPayload(png("a"));
	await h.emit(payload);
	assert.deepEqual(payload.messages[0].content[1], { type: "file", file_id: "file-flag" });
	assert.equal(h.calls[0].headers.Authorization, "Bearer self-key");
});

test("empty config entry {} enables with defaults", async (t) => {
	const h = await harness(t, { modelsJson: providerConfig({}) });
	h.setFetch(async () => fileResponse("file-x"));
	const payload = completionsPayload(png("a"));
	await h.emit(payload);
	assert.deepEqual(payload.messages[0].content[1], { type: "file", file_id: "file-x" });
});

// ---------------------------------------------------------------------------
// payload rewrites
// ---------------------------------------------------------------------------

test("openai-completions rewrites base64 data URIs and leaves http URLs", async (t) => {
	const h = await harness(t, { modelsJson: providerConfig(true) });
	h.setFetch(async () => fileResponse("file-c"));
	const payload = completionsPayload(png("a"));
	await h.emit(payload);
	assert.deepEqual(payload.messages[0].content[1], { type: "file", file_id: "file-c" });

	const httpPayload = completionsPayload("https://example.com/a.png");
	await h.emit(httpPayload);
	assert.deepEqual(httpPayload.messages[0].content[1], {
		type: "image_url",
		image_url: { url: "https://example.com/a.png" },
	});
});

test("openai-responses rewrites input_image and drops detail", async (t) => {
	const h = await harness(t, {
		modelsJson: providerConfig(true),
		model: { api: "openai-responses" },
	});
	h.setFetch(async () => fileResponse("file-r"));
	const payload = responsesPayload(png("a"));
	await h.emit(payload);
	assert.deepEqual(payload.input[0].content[0], { type: "input_image", file_id: "file-r" });

	const httpPayload = responsesPayload("https://example.com/a.png");
	await h.emit(httpPayload);
	assert.equal(httpPayload.input[0].content[0].image_url, "https://example.com/a.png");
});

test("anthropic rewrites image source and adds the files beta", async (t) => {
	const h = await harness(t, {
		modelsJson: providerConfig(true),
		model: { api: "anthropic-messages", baseUrl: "https://api.deepseek.com/anthropic" },
	});
	h.setFetch(async () => fileResponse("file_anthropic"));
	const payload = anthropicPayload(Buffer.from("img").toString("base64"));
	await h.emit(payload);

	assert.deepEqual(payload.messages[0].content[1], {
		type: "image",
		source: { type: "file", file_id: "file_anthropic" },
	});
	assert.deepEqual(payload.betas, ["files-api-2025-04-14"]);

	const call = h.calls[0];
	assert.equal(call.url, "https://api.deepseek.com/anthropic/v1/files");
	assert.equal(call.headers["x-api-key"], "self-key");
	assert.equal(call.headers["anthropic-version"], "2023-06-01");
	assert.equal(call.headers["anthropic-beta"], "files-api-2025-04-14");
	assert.deepEqual(call.form.map(([key]) => key), ["file", "expires_in_seconds"]);
});

test("anthropic leaves url and existing file sources untouched", async (t) => {
	const h = await harness(t, {
		modelsJson: providerConfig(true),
		model: { api: "anthropic-messages", baseUrl: "https://api.deepseek.com/anthropic" },
	});
	const payload: any = {
		messages: [
			{
				role: "user",
				content: [
					{ type: "image", source: { type: "url", url: "https://example.com/a.png" } },
					{ type: "image", source: { type: "file", file_id: "file-existing" } },
				],
			},
		],
	};
	await h.emit(payload);
	assert.deepEqual(payload.messages[0].content[0].source, { type: "url", url: "https://example.com/a.png" });
	assert.deepEqual(payload.messages[0].content[1].source, { type: "file", file_id: "file-existing" });
	assert.equal(h.calls.length, 0);
	assert.equal(payload.betas, undefined);
});

test("anthropic payload betas merges with existing betas", async (t) => {
	const h = await harness(t, {
		modelsJson: providerConfig(true),
		model: { api: "anthropic-messages", baseUrl: "https://api.deepseek.com/anthropic" },
	});
	h.setFetch(async () => fileResponse("file_b"));
	const payload = anthropicPayload(Buffer.from("img").toString("base64"));
	payload.betas = ["interleaved-thinking-2025-05-14"];
	await h.emit(payload);
	assert.deepEqual(payload.betas, ["interleaved-thinking-2025-05-14", "files-api-2025-04-14"]);
});

// ---------------------------------------------------------------------------
// flavor and auth overrides
// ---------------------------------------------------------------------------

test("filesApi.api: openai uses the OpenAI upload shape for anthropic requests", async (t) => {
	const h = await harness(t, {
		modelsJson: {
			providers: {
				"test-provider": {
					baseUrl: "https://api.deepseek.com/anthropic",
					api: "anthropic-messages",
					apiKey: "k",
					filesApi: { enabled: true, api: "openai", baseUrl: "https://api.deepseek.com" },
					models: [{ id: "vision", input: ["text", "image"] }],
				},
			},
		},
		model: { api: "anthropic-messages", baseUrl: "https://api.deepseek.com/anthropic" },
	});
	h.setFetch(async () => fileResponse("file_mixed"));
	const payload = anthropicPayload(Buffer.from("img").toString("base64"));
	await h.emit(payload);

	const call = h.calls[0];
	assert.equal(call.url, "https://api.deepseek.com/files");
	assert.equal(call.headers.Authorization, "Bearer self-key");
	assert.equal(formValue(call, "purpose"), "user_data");
	assert.ok(call.form.some(([key]) => key === "file"));
	assert.deepEqual(payload.betas, ["files-api-2025-04-14"]);
});

test("authProvider uses another provider's credentials and base URL", async (t) => {
	const h = await harness(t, {
		modelsJson: {
			providers: {
				"test-provider": {
					baseUrl: "https://gateway.example/v1",
					api: "openai-completions",
					apiKey: "k",
					filesApi: { enabled: true, authProvider: "other" },
					models: [{ id: "vision", input: ["text", "image"] }],
				},
			},
		},
		providerAuth: { other: { auth: { apiKey: "other-key", headers: { "x-extra": "1" } } } },
		providers: { other: { baseUrl: "https://files.example.com" } },
	});
	h.setFetch(async () => fileResponse("file-auth"));
	await h.emit(completionsPayload(png("a")));
	assert.equal(h.calls[0].url, "https://files.example.com/files");
	assert.equal(h.calls[0].headers.Authorization, "Bearer other-key");
	assert.equal(h.calls[0].headers["x-extra"], "1");
});

test("apiKey override expands environment variables", async (t) => {
	process.env.FILES_API_TEST_KEY = "secret-key";
	t.after(() => delete process.env.FILES_API_TEST_KEY);
	const h = await harness(t, {
		modelsJson: providerConfig({ enabled: true, apiKey: "$FILES_API_TEST_KEY" }),
	});
	h.setFetch(async () => fileResponse("file-key"));
	await h.emit(completionsPayload(png("a")));
	assert.equal(h.calls[0].headers.Authorization, "Bearer secret-key");
});

// ---------------------------------------------------------------------------
// upload shape
// ---------------------------------------------------------------------------

test("openai upload sends purpose and expires_after by default", async (t) => {
	const h = await harness(t, { modelsJson: providerConfig(true) });
	h.setFetch(async () => fileResponse("file-u"));
	await h.emit(completionsPayload(png("a")));
	const call = h.calls[0];
	assert.equal(formValue(call, "purpose"), "user_data");
	assert.equal(formValue(call, "expires_after[anchor]"), "created_at");
	assert.equal(formValue(call, "expires_after[seconds]"), "604800");
});

test("purpose override is used", async (t) => {
	const h = await harness(t, { modelsJson: providerConfig({ enabled: true, purpose: "custom" }) });
	h.setFetch(async () => fileResponse("file-p"));
	await h.emit(completionsPayload(png("a")));
	assert.equal(formValue(h.calls[0], "purpose"), "custom");
});

test("default purpose is vision for the openai provider", async (t) => {
	const h = await harness(t, { flags: { "files-api": true }, model: { provider: "openai" } });
	h.setFetch(async () => fileResponse("file-o"));
	await h.emit(completionsPayload(png("a")));
	assert.equal(formValue(h.calls[0], "purpose"), "vision");
});

test("uploaded filename extension follows the media type", async (t) => {
	const h = await harness(t, { modelsJson: providerConfig(true) });
	h.setFetch(async () => fileResponse("file-j"));
	await h.emit(completionsPayload(jpeg("a")));
	const file = formValue(h.calls[0], "file") as { name: string };
	assert.ok(file.name.endsWith(".jpg"), file.name);
});

// ---------------------------------------------------------------------------
// caching
// ---------------------------------------------------------------------------

test("identical images are uploaded once", async (t) => {
	const h = await harness(t, { modelsJson: providerConfig(true) });
	h.setFetch(async () => fileResponse("file-cache"));
	await h.emit(completionsPayload(png("same")));
	await h.emit(completionsPayload(png("same")));
	assert.equal(h.calls.length, 1);
	assert.match(await h.command("stats"), /cache hits: 1/);
});

test("concurrent identical images share one in-flight upload", async (t) => {
	const h = await harness(t, { modelsJson: providerConfig(true) });
	h.setFetch(async () => fileResponse("file-conc"));
	const payloads = [completionsPayload(png("same")), completionsPayload(png("same"))];
	await Promise.all(payloads.map((payload) => h.emit(payload)));
	assert.equal(h.calls.length, 1);
	assert.deepEqual(payloads[0].messages[0].content[1], { type: "file", file_id: "file-conc" });
	assert.deepEqual(payloads[1].messages[0].content[1], { type: "file", file_id: "file-conc" });
});

test("expired cached file ids are ignored and re-uploaded", async (t) => {
	const h = await harness(t, { modelsJson: providerConfig(true) });
	h.setFetch(async () => fileResponse("file-old", secondsFromNow(-60)));
	const first = completionsPayload(png("a"));
	await h.emit(first);
	assert.deepEqual(first.messages[0].content[1], { type: "file", file_id: "file-old" });

	// The stored entry is already expired, so the next request re-uploads.
	h.setFetch(async () => fileResponse("file-new", secondsFromNow(3600)));
	const second = completionsPayload(png("a"));
	await h.emit(second);
	assert.deepEqual(second.messages[0].content[1], { type: "file", file_id: "file-new" });
	assert.equal(h.calls.length, 2);
	const stats = await h.command("stats");
	assert.match(stats, /cache hits: 0/);
	assert.match(stats, /expired dropped: 1/);
});

test("non-expired cached file ids are reused without a re-upload", async (t) => {
	const h = await harness(t, { modelsJson: providerConfig(true) });
	h.setFetch(async () => fileResponse("file-live", secondsFromNow(3600)));
	await h.emit(completionsPayload(png("a")));
	await h.emit(completionsPayload(png("a")));
	assert.equal(h.calls.length, 1);
	assert.match(await h.command("stats"), /cache hits: 1/);
});

test("openai uploads record a future expiry derived from expires_after", async (t) => {
	const h = await harness(t, { modelsJson: providerConfig(true) });
	h.setFetch(async () => fileResponse("file-exp"));
	await h.emit(completionsPayload(png("a")));
	const entry = Object.values(readDiskCache(h.agentDir).entries)[0];
	assert.equal(typeof entry.expiresAt, "string");
	assert.ok(Date.parse(entry.expiresAt as string) > Date.now());
	assert.match(entry.expiresAt as string, /Z$/);
});

test("anthropic uploads send expires_in_seconds and record a future expiry", async (t) => {
	const h = await harness(t, {
		modelsJson: providerConfig(true),
		model: { api: "anthropic-messages", baseUrl: "https://api.deepseek.com/anthropic" },
	});
	h.setFetch(async () => fileResponse("file_anthro"));
	await h.emit(anthropicPayload(Buffer.from("img").toString("base64")));
	assert.equal(formValue(h.calls[0], "expires_in_seconds"), "604800");
	const entry = Object.values(readDiskCache(h.agentDir).entries)[0];
	assert.equal(typeof entry.expiresAt, "string");
	assert.ok(Date.parse(entry.expiresAt as string) > Date.now());
});

test("anthropic parses an RFC 3339 expires_at from the response", async (t) => {
	const h = await harness(t, {
		modelsJson: providerConfig(true),
		model: { api: "anthropic-messages", baseUrl: "https://api.deepseek.com/anthropic" },
	});
	const iso = new Date(Date.now() + 123_000).toISOString();
	h.setFetch(
		async () =>
			new Response(JSON.stringify({ id: "file_rfc", type: "file", expires_at: iso }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
	);
	await h.emit(anthropicPayload(Buffer.from("img").toString("base64")));
	const entry = Object.values(readDiskCache(h.agentDir).entries)[0];
	assert.equal(entry.expiresAt, iso);
});

test("anthropic clamps expires_in_seconds to the allowed range", async (t) => {
	const h = await harness(t, {
		modelsJson: providerConfig({ enabled: true, expiresAfterSeconds: 60 }),
		model: { api: "anthropic-messages", baseUrl: "https://api.deepseek.com/anthropic" },
	});
	h.setFetch(async () => fileResponse("file_clamp"));
	await h.emit(anthropicPayload(Buffer.from("img").toString("base64")));
	assert.equal(formValue(h.calls[0], "expires_in_seconds"), "3600");
});

test("expiresAfterSeconds: null omits expiry for both flavors", async (t) => {
	const openai = await harness(t, { modelsJson: providerConfig({ enabled: true, expiresAfterSeconds: null }) });
	openai.setFetch(async () => fileResponse("file-none"));
	await openai.emit(completionsPayload(png("a")));
	assert.equal(formValue(openai.calls[0], "expires_after[seconds]"), undefined);
	assert.equal(Object.values(readDiskCache(openai.agentDir).entries)[0].expiresAt, undefined);

	const anthropic = await harness(t, {
		modelsJson: providerConfig({ enabled: true, expiresAfterSeconds: null }),
		model: { api: "anthropic-messages", baseUrl: "https://api.deepseek.com/anthropic" },
	});
	anthropic.setFetch(async () => fileResponse("file_none_a"));
	await anthropic.emit(anthropicPayload(Buffer.from("img").toString("base64")));
	assert.equal(formValue(anthropic.calls[0], "expires_in_seconds"), undefined);
	assert.equal(Object.values(readDiskCache(anthropic.agentDir).entries)[0].expiresAt, undefined);
});

test("expired entries are pruned from the disk cache on load", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-files-api-prune-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const modelsJson = providerConfig(true);

	const first = await harness(t, { agentDir, modelsJson });
	first.setFetch(async () => fileResponse("file-expired", secondsFromNow(-5)));
	await first.emit(completionsPayload(png("a")));
	assert.equal(Object.keys(readDiskCache(agentDir).entries).length, 1);

	// A new instance prunes the expired entry when it loads the cache.
	const second = await harness(t, { agentDir, modelsJson });
	await second.command("stats");
	assert.equal(Object.keys(readDiskCache(agentDir).entries).length, 0);
});

test("file_id cache persists to disk across instances", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-files-api-shared-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const modelsJson = providerConfig(true);

	const first = await harness(t, { agentDir, modelsJson });
	first.setFetch(async () => fileResponse("file-persist"));
	await first.emit(completionsPayload(png("persist")));
	assert.equal(first.calls.length, 1);

	const second = await harness(t, { agentDir, modelsJson });
	second.setFetch(async () => {
		throw new Error("should not upload again");
	});
	await second.emit(completionsPayload(png("persist")));
	assert.equal(second.calls.length, 0);
	assert.match(await second.command("stats"), /cache hits: 1/);
});

// ---------------------------------------------------------------------------
// failures and backoff
// ---------------------------------------------------------------------------

test("a failed upload keeps the inline image", async (t) => {
	const h = await harness(t, { modelsJson: providerConfig(true) });
	h.setFetch(async () => errorResponse(500));
	const payload = completionsPayload(png("a"));
	await h.emit(payload);
	assert.equal(payload.messages[0].content[1].type, "image_url");
	assert.ok(h.notifications.some((entry) => entry.message.includes("upload failed")));
	assert.match(await h.command("stats"), /failures: 1/);
});

test("repeated failures trigger a backoff that skips further uploads", async (t) => {
	const h = await harness(t, { modelsJson: providerConfig(true) });
	h.setFetch(async () => errorResponse(500));
	await h.emit(completionsPayload(png("a")));
	await h.emit(completionsPayload(png("b")));
	await h.emit(completionsPayload(png("c")));
	assert.equal(h.calls.length, 3);
	await h.emit(completionsPayload(png("d")));
	assert.equal(h.calls.length, 3, "fourth upload should be skipped by backoff");
	assert.match(await h.command("stats"), /skipped \(backoff\): 1/);
});

test("a cached image is reused while the endpoint is in backoff", async (t) => {
	const h = await harness(t, { modelsJson: providerConfig(true) });
	h.setFetch(async () => fileResponse("file-good"));
	const first = completionsPayload(png("good"));
	await h.emit(first);
	assert.deepEqual(first.messages[0].content[1], { type: "file", file_id: "file-good" });

	h.setFetch(async () => errorResponse(500));
	await h.emit(completionsPayload(png("bad-1")));
	await h.emit(completionsPayload(png("bad-2")));
	await h.emit(completionsPayload(png("bad-3")));
	const before = h.calls.length;

	const cached = completionsPayload(png("good"));
	await h.emit(cached);
	assert.deepEqual(cached.messages[0].content[1], { type: "file", file_id: "file-good" });
	assert.equal(h.calls.length, before, "cached image must not hit the network during backoff");
});

test("--files-api retry resets the backoff", async (t) => {
	const h = await harness(t, { modelsJson: providerConfig(true) });
	h.setFetch(async () => errorResponse(500));
	await h.emit(completionsPayload(png("a")));
	await h.emit(completionsPayload(png("b")));
	await h.emit(completionsPayload(png("c")));
	await h.emit(completionsPayload(png("d")));
	assert.equal(h.calls.length, 3);

	await h.command("retry");
	h.setFetch(async () => fileResponse("file-after-retry"));
	const payload = completionsPayload(png("e"));
	await h.emit(payload);
	assert.equal(h.calls.length, 4);
	assert.deepEqual(payload.messages[0].content[1], { type: "file", file_id: "file-after-retry" });
});

// ---------------------------------------------------------------------------
// command
// ---------------------------------------------------------------------------

test("/files-api reports status and stats", async (t) => {
	const h = await harness(t, {
		modelsJson: providerConfig({ enabled: true, authProvider: "other" }),
		providerAuth: { other: { auth: { apiKey: "k" } } },
		providers: { other: { baseUrl: "https://files.example.com" } },
	});
	h.setFetch(async () => fileResponse("file-cmd"));
	await h.emit(completionsPayload(png("a")));
	const output = await h.command("");
	assert.match(output, /files-api: enabled \(source: models\.json\)/);
	assert.match(output, /files api: openai \(https:\/\/gateway\.example\/v1\/files\)/);
	assert.match(output, /auth: provider:other/);
	assert.match(output, /uploads: 1/);
});

test("/files-api clear empties the cache", async (t) => {
	const h = await harness(t, { modelsJson: providerConfig(true) });
	h.setFetch(async () => fileResponse("file-clear"));
	await h.emit(completionsPayload(png("a")));
	assert.match(await h.command("stats"), /file_ids: 1 memory/);
	assert.match(await h.command("clear"), /cache cleared/);
	assert.match(await h.command("stats"), /file_ids: 0 memory \/ 0 disk/);
});

test("/files-api help lists subcommands", async (t) => {
	const h = await harness(t, { modelsJson: providerConfig(true) });
	const output = await h.command("help");
	assert.match(output, /\/files-api stats/);
	assert.match(output, /\/files-api clear/);
});

test.after(() => {
	globalThis.fetch = originalFetch;
});
