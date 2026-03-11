export function startSse(response) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
}

export function sendSseEvent(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function endSse(response) {
  response.write("data: [DONE]\n\n");
  response.end();
}
