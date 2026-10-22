// Self-check: npm install && node test.ts
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { MAX_REASONING_CHARS, reviveInterrupted } from "./index.ts";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
const assistant = (stopReason: string, content: unknown[]) =>
  ({ role: "assistant", content, stopReason, errorMessage: stopReason === "aborted" ? "aborted" : undefined, timestamp: 0 });
const revive = (messages: unknown[]) => reviveInterrupted(messages as never) as any[] | undefined;

// ── Unit: the rewrite ────────────────────────────────────────────────────────

// Untouched when nothing was interrupted.
assert.equal(revive([user("hi"), assistant("stop", [{ type: "text", text: "hello" }])]), undefined);

// Aborted reply survives as a finished message: reasoning stays a thinking block
// (signature kept), the note, partial text and dropped tool call go in one text block.
const input = [
  user("fix it"),
  assistant("aborted", [
    { type: "thinking", thinking: "maybe the cache... maybe the cache...", thinkingSignature: "reasoning_content" },
    { type: "text", text: "Looking at" },
    { type: "toolCall", id: "1", name: "read", arguments: {} },
  ]),
  user("stop looping"),
];
const snapshot = structuredClone(input);
const out = revive(input)!;
const revived = out[1];
assert.equal(out.length, 3);
assert.equal(revived.stopReason, "stop");
assert.equal(revived.errorMessage, undefined);
assert.deepEqual(revived.content.map((b: any) => b.type), ["thinking", "text"]);
assert.equal(revived.content[0].thinking, "maybe the cache... maybe the cache...");
assert.equal(revived.content[0].thinkingSignature, "reasoning_content");
assert.match(revived.content[1].text, /Interrupted by the user/);
assert.match(revived.content[1].text, /Looking at/);
assert.match(revived.content[1].text, /read/);
// The caller's messages are not modified (the session stays as stored).
assert.deepEqual(input, snapshot);

// Long reasoning keeps exactly the last MAX_REASONING_CHARS, marked as cut.
const long = "a".repeat(MAX_REASONING_CHARS) + "THE-END";
assert.equal(revive([user("x"), assistant("aborted", [{ type: "thinking", thinking: long }])])![1].content[0].thinking,
  "[…] " + long.slice(-MAX_REASONING_CHARS));

// Reasoning without a signature is still kept as a thinking block.
const unsigned = revive([user("x"), assistant("aborted", [{ type: "thinking", thinking: "hmm" }])])![1];
assert.equal(unsigned.content[0].thinking, "hmm");
assert.equal(unsigned.content[0].thinkingSignature, undefined);

// Only an unfinished tool call: no thinking block, just the note naming it.
const toolOnly = revive([user("x"), assistant("aborted", [{ type: "toolCall", id: "1", name: "bash", arguments: {} }])])![1];
assert.deepEqual(toolOnly.content.map((b: any) => b.type), ["text"]);
assert.match(toolOnly.content[0].text, /Unfinished tool call \(not executed\): bash/);

// Every aborted reply in the conversation is revived.
const twice = revive([
  user("a"), assistant("aborted", [{ type: "thinking", thinking: "first" }]),
  user("b"), assistant("aborted", [{ type: "thinking", thinking: "second" }]),
  user("c"),
])!;
assert.deepEqual(twice.filter((m) => m.role === "assistant").map((m) => [m.stopReason, m.content[0].thinking]),
  [["stop", "first"], ["stop", "second"]]);

// Errored replies are out of scope and left for pi to drop.
assert.equal(revive([user("x"), assistant("error", [{ type: "thinking", thinking: "partial" }])]), undefined);

// Empty or whitespace-only aborted replies are left for pi to drop.
assert.equal(revive([user("x"), assistant("aborted", [])]), undefined);
assert.equal(revive([user("x"), assistant("aborted", [{ type: "thinking", thinking: "  \n " }])]), undefined);

// ── Integration: real pi session → real OpenAI-compatible adapter → fake llama.cpp ──
// pi-ai drops aborted replies inside the provider adapter, so only the request
// body on the wire shows whether the extension's rewrite survives.

const bodies: any[] = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    bodies.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const model = { id: "qwen3.8-27b", name: "q", api: "openai-completions", provider: "llama-cpp", baseUrl,
  reasoning: true, input: ["text"], contextWindow: 98304, maxTokens: 12288, cost } as const;

async function assistantsSent(withExtension: boolean): Promise<any[]> {
  const root = mkdtempSync(join(tmpdir(), "pi-interrupt-me-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    // Same shape as a real ~/.pi/agent/models.json entry for llama.cpp.
    writeFileSync(join(root, "models.json"), JSON.stringify({ providers: { "llama-cpp": {
      baseUrl, api: "openai-completions", apiKey: "none",
      models: [{ id: model.id, name: model.name, reasoning: true, input: ["text"], contextWindow: 98304, maxTokens: 12288, cost }],
    } } }));
    const sessionManager = SessionManager.inMemory(root);
    sessionManager.appendMessage(user("why is the build failing") as never);
    sessionManager.appendMessage({ role: "assistant", api: model.api, provider: model.provider, model: model.id, stopReason: "aborted",
      usage: { ...cost, totalTokens: 0, cost: { ...cost, total: 0 } }, timestamp: 2,
      content: [{ type: "thinking", thinking: "check the cache... check the cache...", thinkingSignature: "reasoning_content" }] } as never);
    const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, noExtensions: !withExtension,
      additionalExtensionPaths: withExtension ? [new URL("./index.ts", import.meta.url).pathname] : [] });
    await resourceLoader.reload();
    const { session, extensionsResult } = await createAgentSession(
      { cwd: root, agentDir: root, model, resourceLoader, sessionManager, noTools: "all" } as never);
    assert.deepEqual(extensionsResult.errors, []);
    await session.bindExtensions({});
    bodies.length = 0;
    await session.prompt("stop, it's the linker flags");
    assert.equal(bodies.length, 1, "exactly one request reaches the server");
    return bodies[0].messages.filter((m: any) => m.role === "assistant");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

try {
  // Without the extension pi drops the interrupted reply (the bug this package fixes).
  assert.deepEqual(await assistantsSent(false), []);
  // With it, the reasoning goes out in llama.cpp's reasoning field, next to the note.
  const [sent, ...rest] = await assistantsSent(true);
  assert.equal(rest.length, 0);
  assert.equal(sent.reasoning_content, "check the cache... check the cache...");
  assert.match(sent.content, /Interrupted by the user/);
} finally {
  server.close();
}

console.log("ok");
