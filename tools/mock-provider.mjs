/**
 * Minimal OpenAI-compatible streaming mock for end-to-end harness tests.
 *
 * It records every request body to disk and answers with a one-token SSE stream,
 * so a real agent loop can run with no credentials and no network.
 */
import http from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";

const PORT = Number(process.env.MOCK_PORT ?? 8787);
const CAPTURE =
  process.env.MOCK_CAPTURE ??
  new URL("./last-request.json", import.meta.url).pathname;
const LOG =
  process.env.MOCK_LOG ?? new URL("./requests.jsonl", import.meta.url).pathname;
/** Absolute path the mock asks the agent to `read` once (optional). */
const READ_FILE = process.env.MOCK_READ_FILE;

const server = http.createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    try {
      writeFileSync(CAPTURE, body);
    } catch (error) {
      console.error("[mock] capture failed:", error.message);
    }
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      /* leave parsed null */
    }
    try {
      appendFileSync(
        LOG,
        JSON.stringify({
          url: req.url,
          model: parsed?.model,
          purpose: parsed?.purpose,
          messages: parsed?.messages,
        }) + "\n",
      );
    } catch (error) {
      console.error("[mock] log failed:", error.message);
    }
    const messages = parsed?.messages ?? [];
    console.error(`[mock] ${req.url} model=${parsed?.model} messages=${messages.length}`);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const model = parsed?.model ?? "mock";
    const chunk = (delta, finish = null) => ({
      id: "mock-1",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    res.write(`data: ${JSON.stringify(chunk({ role: "assistant" }))}\n\n`);
    // With MOCK_READ_FILE set, the first agent request asks for one `read`
    // call of that file, so the tool-result path is exercised too.
    const offersRead = (parsed?.tools ?? []).some((tool) => tool.function?.name === "read");
    const hasToolResult = messages.some((message) => message.role === "tool");
    if (READ_FILE && offersRead && !hasToolResult) {
      const call = {
        index: 0,
        id: "call_1",
        type: "function",
        function: { name: "read", arguments: JSON.stringify({ file_path: READ_FILE }) },
      };
      res.write(`data: ${JSON.stringify(chunk({ tool_calls: [call] }))}\n\n`);
      res.write(`data: ${JSON.stringify(chunk({}, "tool_calls"))}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify(chunk({ content: "OK" }))}\n\n`);
      res.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`[mock] listening on http://127.0.0.1:${PORT}`);
});
