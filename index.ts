/**
 * pi-interrupt-me: keep interrupted replies visible to the model.
 *
 * pi-ai drops every assistant message with stopReason "aborted" before a
 * request is sent (transform-messages.js), so after you press Esc the model
 * never sees what it was thinking and reads your two messages as back to back.
 * This extension rewrites those messages in the outgoing context only; the
 * session file is untouched.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ThinkingContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// wozniak: fixed tail cut. 300 matches CliffCompaction's cap on old thoughts
// (arXiv 2609.26779, Alg. 1) and is about one median Qwen thinking paragraph.
// The end is kept because it is what the user interrupted. Ceiling: not ablated
// by anyone for interrupted reasoning; upgrade path is measuring on real sessions.
export const MAX_REASONING_CHARS = 300;

const tail = (s: string) =>
  s.length > MAX_REASONING_CHARS ? "[…] " + s.slice(-MAX_REASONING_CHARS) : s;

export function reviveInterrupted(messages: AgentMessage[]): AgentMessage[] | undefined {
  let changed = false;
  const out = messages.map((m) => {
    if (m.role !== "assistant") return m;
    const msg = m as AssistantMessage;
    if (msg.stopReason !== "aborted" || msg.content.length === 0) return m;

    const thinkingBlocks = msg.content.filter((b) => b.type === "thinking" && b.thinking.trim());
    const text = msg.content.flatMap((b) => (b.type === "text" && b.text.trim() ? [b.text.trim()] : []));
    const tools = msg.content.flatMap((b) => (b.type === "toolCall" ? [b.name] : []));
    if (!thinkingBlocks.length && !text.length && !tools.length) return m;

    const parts = ["[Interrupted by the user before this reply finished.]"];
    if (text.length) parts.push("Partial answer:\n" + text.join("\n"));
    if (tools.length) parts.push("Unfinished tool call (not executed): " + tools.join(", "));

    // Reasoning stays a thinking block so it is replayed in the model's normal
    // reasoning slot; the original signature (e.g. "reasoning_content" for
    // llama.cpp) tells pi-ai which field to send it in.
    const content: AssistantMessage["content"] = [];
    if (thinkingBlocks.length) {
      const first = thinkingBlocks[0] as ThinkingContent;
      content.push({
        type: "thinking",
        thinking: tail(thinkingBlocks.map((b) => (b as ThinkingContent).thinking.trim()).join("\n")),
        thinkingSignature: first.thinkingSignature,
      });
    }
    content.push({ type: "text", text: parts.join("\n\n") });

    changed = true;
    const { errorMessage: _, ...rest } = msg;
    return { ...rest, stopReason: "stop", content } as AssistantMessage;
  });
  return changed ? out : undefined;
}

export default function (pi: ExtensionAPI) {
  pi.on("context", (event) => {
    const messages = reviveInterrupted(event.messages);
    return messages ? { messages } : undefined;
  });
}
