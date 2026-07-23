import { handleRequest } from "./server.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("timer and chat routes are served independently", async () => {
  const timerResponse = await handleRequest(new Request("http://localhost/"));
  assert(timerResponse.status === 200, "timer route should return 200");
  const timerHtml = await timerResponse.text();
  assert(
    timerHtml.includes("Paradise Timer"),
    "timer route should serve the timer page",
  );
  assert(
    timerHtml.includes('href="/chat/"'),
    "timer route should expose chat navigation",
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

Deno.test("chat room API routes use the configured handler", async () => {
  const handledPaths: string[] = [];
  const dependencies = {
    chatRoomHandler: (request: Request) => {
      handledPaths.push(new URL(request.url).pathname);
      return Promise.resolve(Response.json({ ok: true }, { status: 202 }));
    },
  };
  const paths = ["/api/chat/rooms", "/api/chat/rooms/room-0000000000000001"];
  for (const path of paths) {
    const response = await handleRequest(
      new Request(`http://localhost${path}`),
      dependencies,
    );
    assert(response.status === 202, "room handler response should be returned");
  }
  assert(
    JSON.stringify(handledPaths) === JSON.stringify(paths),
    "room collection and item routes should be delegated",
  );
});

Deno.test("chat join request API routes use the configured handler", async () => {
  const handledPaths: string[] = [];
  const dependencies = {
    chatJoinRequestHandler: (request: Request) => {
      handledPaths.push(new URL(request.url).pathname);
      return Promise.resolve(Response.json({ ok: true }, { status: 202 }));
    },
  };
  const room = "room-0000000000000001";
  const routes = [
    [`/api/chat/rooms/${room}/requests`, "POST"],
    [`/api/chat/rooms/${room}/requests/user-1/approve`, "POST"],
    [`/api/chat/rooms/${room}/requests/user-1/reject`, "POST"],
    [`/api/chat/rooms/${room}/members`, "GET"],
    [`/api/chat/rooms/${room}/members/user-1`, "PATCH"],
    [`/api/chat/rooms/${room}/members/user-1`, "DELETE"],
  ];
  for (const [path, method] of routes) {
    const response = await handleRequest(
      new Request(`http://localhost${path}`, { method }),
      dependencies,
    );
    assert(
      response.status === 202,
      "join request handler response should be returned",
    );
  }
  assert(
    JSON.stringify(handledPaths) ===
      JSON.stringify(routes.map(([path]) => path)),
    "all join request routes should be delegated",
  );
});

Deno.test("chat message API routes use the configured handler", async () => {
  const handledPaths: string[] = [];
  const dependencies = {
    chatMessageHandler: (request: Request) => {
      handledPaths.push(new URL(request.url).pathname);
      return Promise.resolve(Response.json({ ok: true }, { status: 202 }));
    },
  };
  const room = "room-0000000000000001";
  const message = "01J00000000000000000000000";
  const routes = [
    [`/api/chat/rooms/${room}/messages`, "GET"],
    [`/api/chat/rooms/${room}/messages`, "POST"],
    [`/api/chat/rooms/${room}/messages/${message}`, "DELETE"],
  ];
  for (const [path, method] of routes) {
    const response = await handleRequest(
      new Request(`http://localhost${path}`, { method }),
      dependencies,
    );
    assert(
      response.status === 202,
      "message handler response should be returned",
    );
  }
  assert(
    JSON.stringify(handledPaths) ===
      JSON.stringify(routes.map(([path]) => path)),
    "all message routes should be delegated",
  );
});

Deno.test("chat event route uses the configured SSE handler", async () => {
  const handledPaths: string[] = [];
  const response = await handleRequest(
    new Request("http://localhost/api/chat/events"),
    {
      chatEventHandler: (request) => {
        handledPaths.push(new URL(request.url).pathname);
        return Promise.resolve(new Response("stream", { status: 202 }));
      },
    },
  );
  assert(response.status === 202, "event handler response should be returned");
  assert(
    handledPaths.length === 1 && handledPaths[0] === "/api/chat/events",
    "event route should be delegated exactly once",
  );
});
