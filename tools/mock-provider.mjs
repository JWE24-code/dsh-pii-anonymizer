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
    res.write(`data: ${JSON.stringify(chunk({ content: "OK" }))}\n\n`);
    res.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`[mock] listening on http://127.0.0.1:${PORT}`);
});
