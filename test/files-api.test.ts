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
	const entries: Array<{ customType: string; data: any }> = [];
	const entryRenderers: Record<string, any> = {};
	const pi = {
		on: (event: string, handler: (...args: any[]) => any) => {
			(handlers[event] ??= []).push(handler);
		},
		registerFlag: () => {},
		getFlag: (name: string) => flags[name],
		registerCommand: (name: string, definition: any) => {
			commands[name] = definition;
		},
		registerEntryRenderer: (customType: string, renderer: any) => {
			entryRenderers[customType] = renderer;
		},
		appendEntry: (customType: string, data?: any) => {
			entries.push({ customType, data });
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
		entries,
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
		renderEntry(customType: string, data: any): string {
			const renderer = entryRenderers[customType];
			const theme = { fg: (_color: string, text: string) => text };
			const component = renderer({ data }, { expanded: false }, theme);
			return component.render(80).join("\n");
		},
		async emit(payload: any) {
			let current = payload;
			for (const handler of handlers["before_provider_request"] ?? []) {
				const result = await handler({ type: "before_provider_request", payload: current }, ctx);
				if (result !== undefined) current = result;
			}
			return current;
		},
		async emitToolResult(content: any[], input: Record<string, unknown> = {}, toolCallId = "call-1") {
			for (const handler of handlers["tool_result"] ?? []) {
				await handler(
					{ type: "tool_result", toolName: "read", toolCallId, input, content, isError: false },
					ctx,
				);
			}
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

test("authProvider derives the Files API flavor from the auth provider's API", async (t) => {
	const h = await harness(t, {
		modelsJson: {
			providers: {
				"test-provider": {
					baseUrl: "https://axonhub.example/anthropic",
					api: "anthropic-messages",
					apiKey: "k",
					filesApi: { enabled: true, authProvider: "deepseek" },
					models: [{ id: "vision", input: ["text", "image"] }],
				},
				deepseek: { api: "openai-completions", baseUrl: "https://api.deepseek.com" },
			},
		},
		model: { api: "anthropic-messages", baseUrl: "https://axonhub.example/anthropic" },
		providerAuth: { deepseek: { auth: { apiKey: "ds-key" } } },
		providers: { deepseek: { baseUrl: "https://api.deepseek.com" } },
	});
	h.setFetch(async () => fileResponse("file_ds"));
	const payload = anthropicPayload(Buffer.from("img").toString("base64"));
	await h.emit(payload);

	// The request stays Anthropic-shaped, but the upload follows DeepSeek's OpenAI shape.
	assert.deepEqual(payload.messages[0].content[1], {
		type: "image",
		source: { type: "file", file_id: "file_ds" },
	});
	assert.deepEqual(payload.betas, ["files-api-2025-04-14"]);
	const call = h.calls[0];
	assert.equal(call.url, "https://api.deepseek.com/files");
	assert.equal(call.headers.Authorization, "Bearer ds-key");
	assert.equal(call.headers["x-api-key"], undefined);
	assert.equal(formValue(call, "purpose"), "user_data");
});

test("authProvider flavor falls back to the registry catalog's API", async (t) => {
	const h = await harness(t, {
		modelsJson: {
			providers: {
				"test-provider": {
					baseUrl: "https://axonhub.example/anthropic",
					api: "anthropic-messages",
					apiKey: "k",
					filesApi: { enabled: true, authProvider: "deepseek" },
					models: [{ id: "vision", input: ["text", "image"] }],
				},
			},
		},
		model: { api: "anthropic-messages", baseUrl: "https://axonhub.example/anthropic" },
		providerAuth: { deepseek: { auth: { apiKey: "ds-key" } } },
		providers: {
			deepseek: { baseUrl: "https://api.deepseek.com", getModels: () => [{ api: "openai-completions" }] },
		},
	});
	h.setFetch(async () => fileResponse("file_reg"));
	await h.emit(anthropicPayload(Buffer.from("img").toString("base64")));
	assert.equal(h.calls[0].url, "https://api.deepseek.com/files");
	assert.equal(h.calls[0].headers.Authorization, "Bearer ds-key");
});

test("explicit filesApi.api wins over the authProvider flavor", async (t) => {
	const h = await harness(t, {
		modelsJson: {
			providers: {
				"test-provider": {
					baseUrl: "https://axonhub.example/anthropic",
					api: "anthropic-messages",
					apiKey: "k",
					filesApi: { enabled: true, api: "anthropic", authProvider: "deepseek" },
					models: [{ id: "vision", input: ["text", "image"] }],
				},
				deepseek: { api: "openai-completions" },
			},
		},
		model: { api: "anthropic-messages", baseUrl: "https://axonhub.example/anthropic" },
		providerAuth: { deepseek: { auth: { apiKey: "ds-key" } } },
		providers: { deepseek: { baseUrl: "https://api.deepseek.com" } },
	});
	h.setFetch(async () => fileResponse("file_anth"));
	await h.emit(anthropicPayload(Buffer.from("img").toString("base64")));
	assert.equal(h.calls[0].url, "https://api.deepseek.com/v1/files");
	assert.equal(h.calls[0].headers["x-api-key"], "ds-key");
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
// logging
// ---------------------------------------------------------------------------

test("logs an image once and stays quiet on later requests", async (t) => {
	const h = await harness(t, { modelsJson: providerConfig(true) });
	h.setFetch(async () => fileResponse("file-log"));
	await h.emit(completionsPayload(png("a")));
	const upload = h.entries.find((entry) => entry.customType === "files-api-log");
	assert.ok(upload, JSON.stringify(h.entries));
	assert.equal(upload!.data.id, "file-log");
	assert.match(upload!.data.detail, /^uploaded \(/);
	// Nothing pops up; it is printed in the transcript instead.
	assert.equal(h.notifications.length, 0);
	assert.match(h.renderEntry("files-api-log", upload!.data), /files-api: uploaded \(.*\) file-log/);

	// Replaying the same image on later requests reuses the file id silently.
	await h.emit(completionsPayload(png("a")));
	await h.emit(completionsPayload(png("a")));
	assert.equal(h.entries.length, 1);
	assert.equal(h.notifications.length, 0);
});

test("reusing an image from the on-disk cache is not logged", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-files-api-log-cache-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const modelsJson = providerConfig(true);

	const first = await harness(t, { agentDir, modelsJson });
	first.setFetch(async () => fileResponse("file-persist-log"));
	await first.emit(completionsPayload(png("a")));
	assert.equal(first.entries.length, 1);

	const second = await harness(t, { agentDir, modelsJson });
	second.setFetch(async () => {
		throw new Error("should not upload");
	});
	await second.emit(completionsPayload(png("a")));
	assert.equal(second.entries.length, 0);
	assert.match(await second.command("stats"), /cache hits: 1/);
});

test("logs the source file name for an image from the read tool", async (t) => {
	const h = await harness(t, {
		modelsJson: providerConfig(true),
		model: { api: "anthropic-messages", baseUrl: "https://api.deepseek.com/anthropic" },
	});
	h.setFetch(async () => fileResponse("file-named"));
	const dataUri = png("photo");
	const base64 = dataUri.slice(dataUri.indexOf(",") + 1);
	await h.emitToolResult([{ type: "image", data: base64, mimeType: "image/png" }], {
		path: "/tmp/pictures/cat.png",
	});
	await h.emit({
		model: "m",
		max_tokens: 10,
		messages: [
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call-1",
						content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: base64 } }],
					},
				],
			},
		],
	});

	assert.equal(h.entries.length, 1);
	assert.equal(h.entries[0].data.id, "file-named");
	assert.match(h.entries[0].data.detail, /^uploaded cat\.png \(/);
	assert.match(h.renderEntry("files-api-log", h.entries[0].data), /files-api: uploaded cat\.png \(.*\) file-named/);
	const file = formValue(h.calls[0], "file") as { name: string };
	assert.equal(file.name, "cat.png");
});

test("maps an image to its exact read tool call even when files share bytes", async (t) => {
	const h = await harness(t, {
		modelsJson: providerConfig(true),
		model: { api: "anthropic-messages", baseUrl: "https://api.deepseek.com/anthropic" },
	});
	h.setFetch(async () => fileResponse("file-direct"));
	const dataUri = png("same-bytes");
	const base64 = dataUri.slice(dataUri.indexOf(",") + 1);
	const image = [{ type: "image", data: base64, mimeType: "image/png" }];
	// Both reads returned identical bytes, so only the tool call id can tell them
	// apart; the name must come from the call, never from the content.
	await h.emitToolResult(image, { path: "/a/dog.png" }, "call-2");
	await h.emitToolResult(image, { path: "/a/cat.png" }, "call-1");

	await h.emit({
		model: "m",
		max_tokens: 10,
		messages: [
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call-1",
						content: [
							{ type: "text", text: "Read image file [image/png]" },
							{ type: "image", source: { type: "base64", media_type: "image/png", data: base64 } },
						],
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call-2",
						content: [
							{ type: "image", source: { type: "base64", media_type: "image/png", data: base64 } },
						],
					},
				],
			},
		],
	});

	assert.equal(h.entries.length, 1);
	assert.match(h.entries[0].data.detail, /^uploaded cat\.png \(/);
	const file = formValue(h.calls[0], "file") as { name: string };
	assert.equal(file.name, "cat.png");
});

test("maps an image to its function call output in openai-responses", async (t) => {
	const h = await harness(t, {
		modelsJson: providerConfig(true),
		model: { api: "openai-responses" },
	});
	h.setFetch(async () => fileResponse("file-fc"));
	const dataUri = png("resp");
	const base64 = dataUri.slice(dataUri.indexOf(",") + 1);
	await h.emitToolResult([{ type: "image", data: base64, mimeType: "image/png" }], { path: "/a/plot.png" }, "call_x");
	await h.emit({
		model: "m",
		input: [
			{ type: "function_call", call_id: "call_x", name: "read", arguments: '{"path":"/a/plot.png"}' },
			{
				type: "function_call_output",
				call_id: "call_x",
				output: [
					{ type: "input_text", text: "Read image file [image/png]" },
					{ type: "input_image", detail: "auto", image_url: `data:image/png;base64,${base64}` },
				],
			},
		],
	});
	assert.equal(h.entries.length, 1);
	assert.match(h.entries[0].data.detail, /^uploaded plot\.png \(/);
});

test("leaves detached OpenAI Completions tool images unnamed", async (t) => {
	// The completions adapter moves tool-result images into a synthetic user
	// message, so there is no tool call id to correlate; no name is guessed.
	const h = await harness(t, { modelsJson: providerConfig(true) });
	h.setFetch(async () => fileResponse("file-anon"));
	const dataUri = png("photo");
	const base64 = dataUri.slice(dataUri.indexOf(",") + 1);
	await h.emitToolResult([{ type: "image", data: base64, mimeType: "image/png" }], { path: "/a/cat.png" });
	await h.emit(completionsPayload(dataUri));
	assert.equal(h.entries.length, 1);
	assert.match(h.entries[0].data.detail, /^uploaded \(/);
	const file = formValue(h.calls[0], "file") as { name: string };
	assert.match(file.name, /^image-[0-9a-f]{12}\.png$/);
});

test("logs an image once even when it is referenced repeatedly in one request", async (t) => {
	const h = await harness(t, { modelsJson: providerConfig(true) });
	h.setFetch(async () => fileResponse("file-dup"));
	const payload = {
		model: "m",
		messages: [
			{
				role: "user",
				content: [
					{ type: "image_url", image_url: { url: png("same") } },
					{ type: "image_url", image_url: { url: png("same") } },
				],
			},
		],
	};
	await h.emit(payload);
	assert.equal(h.entries.length, 1);
	assert.equal(h.entries[0].data.id, "file-dup");
	assert.match(h.entries[0].data.detail, /^uploaded/);
});

test("logs to stderr outside the TUI", async (t) => {
	const h = await harness(t, { modelsJson: providerConfig(true), mode: "print" });
	const lines: string[] = [];
	const original = console.error;
	console.error = (message?: unknown) => {
		lines.push(String(message));
	};
	t.after(() => {
		console.error = original;
	});
	h.setFetch(async () => fileResponse("file-print"));
	await h.emit(completionsPayload(png("a")));
	assert.ok(lines.some((line) => line.includes("uploaded") && line.includes("file-print")));
	assert.equal(h.entries.length, 0);
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
	assert.match(output, /files api: openai \(https:\/\/files\.example\.com\/files\)/);
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
