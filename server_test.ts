import { handleRequest } from "./server.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("timer and chat routes are served independently", async () => {
  const timerResponse = await handleRequest(new Request("http://localhost/"));
  assert(timerResponse.status === 200, "timer route should return 200");
  assert(
    (await timerResponse.text()).includes("Paradise Timer"),
    "timer route should serve the timer page",
  );

  const chatResponse = await handleRequest(
    new Request("http://localhost/chat/rooms/example-room"),
  );
  assert(chatResponse.status === 200, "chat route should return 200");
  assert(
    (await chatResponse.text()).includes("チャット機能を準備しています。"),
    "chat route should serve the chat shell",
  );
});

Deno.test("chat health endpoint is available", async () => {
  const response = await handleRequest(
    new Request("http://localhost/api/chat/health"),
  );
  assert(response.status === 200, "health endpoint should return 200");
  const body = await response.json();
  assert(body.ok === true, "health response should be healthy");
  assert(body.service === "chat", "health response should identify chat");
});

Deno.test("chat authentication routes use the configured handler", async () => {
  let handledPath = "";
  const response = await handleRequest(
    new Request("http://localhost/api/chat/auth/request-otp", {
      method: "POST",
    }),
    {
      chatAuthHandler: (request) => {
        handledPath = new URL(request.url).pathname;
        return Promise.resolve(Response.json({ ok: true }, { status: 202 }));
      },
    },
  );
  assert(response.status === 202, "auth handler response should be returned");
  assert(
    handledPath === "/api/chat/auth/request-otp",
    "auth route should be delegated",
  );
});
