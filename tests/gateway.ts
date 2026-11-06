import { vi } from "vitest";

export type SeenRequest = {
  url: string;
  headers: Record<string, string>;
  body: { model: string; stream?: boolean; [key: string]: unknown };
};

type Answer = { input?: number; output?: number; answeredBy?: string; warnings?: unknown[] };
type Reply =
  | ({ text: string } & Answer)
  | ({ toolCall: { name: string; args: unknown } } & Answer);

export type ManagementCall = { path: string; body: Record<string, unknown>; auth: string | undefined };

/**
 * Replaces fetch with a fake OpenAI compatible gateway. Each request takes the next reply.
 * Returns the list of requests it received.
 */
export function fakeGateway(
  replies: Reply[] = [{ text: "hello" }],
  management?: (call: ManagementCall) => unknown,
  managementSeen: ManagementCall[] = [],
) {
  const seen: SeenRequest[] = [];
  let index = 0;
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://app.weflayr.com/api")) {
      const call: ManagementCall = {
        path: url.slice("https://app.weflayr.com/api".length),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        auth: new Headers(init?.headers).get("authorization") ?? undefined,
      };
      managementSeen.push(call);
      const answer = management ? management(call) : { rows: [], next_cursor: null, has_more: false };
      if (answer instanceof Response) return answer;
      return new Response(JSON.stringify(answer), { headers: { "content-type": "application/json" } });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as SeenRequest["body"];
    seen.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body,
    });
    const reply = replies[Math.min(index, replies.length - 1)]!;
    index += 1;
    const usage = {
      prompt_tokens: reply.input ?? 100,
      completion_tokens: reply.output ?? 20,
      total_tokens: (reply.input ?? 100) + (reply.output ?? 20),
    };
    const message =
      "toolCall" in reply
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `call_${index}`,
                type: "function",
                function: {
                  name: reply.toolCall.name,
                  arguments: JSON.stringify(reply.toolCall.args),
                },
              },
            ],
          }
        : { role: "assistant", content: reply.text };
    const finish = "toolCall" in reply ? "tool_calls" : "stop";

    if (body.stream) {
      const delta =
        "toolCall" in reply
          ? {
              role: "assistant",
              tool_calls: [{ index: 0, ...message.tool_calls![0] }],
            }
          : { role: "assistant", content: reply.text };
      const chunks = [
        { id: "x", object: "chat.completion.chunk", created: 1, model: reply.answeredBy ?? body.model, choices: [{ index: 0, delta, finish_reason: null }] },
        { id: "x", object: "chat.completion.chunk", created: 1, model: reply.answeredBy ?? body.model, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage },
      ];
      const text =
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
        "data: [DONE]\n\n";
      return new Response(text, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response(
      JSON.stringify({
        id: "x",
        object: "chat.completion",
        created: 1,
        model: reply.answeredBy ?? body.model,
        ...(reply.warnings ? { weflayr_warnings: reply.warnings } : {}),
        choices: [{ index: 0, message, finish_reason: finish }],
        usage,
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  return seen;
}

export function metadataOf(request: SeenRequest | undefined) {
  return JSON.parse(request?.headers["x-weflayr-metadata"] ?? "null") as {
    feature_name: string;
    call_name: string;
    customer_name?: string;
    feature_run_uuid?: string;
    tags?: Record<string, string>;
  };
}
