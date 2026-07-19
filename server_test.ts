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
    (await chatResponse.text()).includes('id="chatApp"'),
    "chat route should serve the interactive chat shell",
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
  const handledPaths: string[] = [];
  const dependencies = {
    chatAuthHandler: (request: Request) => {
      handledPaths.push(new URL(request.url).pathname);
      return Promise.resolve(Response.json({ ok: true }, { status: 202 }));
    },
  };
  const paths = [
    "/api/chat/auth/request-otp",
    "/api/chat/auth/verify-otp",
    "/api/chat/auth/logout",
    "/api/chat/me",
  ];
  for (const path of paths) {
    const response = await handleRequest(
      new Request(`http://localhost${path}`, { method: "POST" }),
      dependencies,
    );
    assert(response.status === 202, "auth handler response should be returned");
  }
  assert(
    JSON.stringify(handledPaths) === JSON.stringify(paths),
    "all auth and session routes should be delegated",
  );
});
