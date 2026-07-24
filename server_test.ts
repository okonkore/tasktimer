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
    chatResponse.headers.get("content-security-policy")?.includes(
      "frame-ancestors 'none'",
    ),
    "chat pages should prevent framing and restrict content sources",
  );
  assert(
    chatResponse.headers.get("x-frame-options") === "DENY",
    "chat pages should include legacy clickjacking protection",
  );
  assert(
    chatResponse.headers.get("cache-control") === "no-cache",
    "chat HTML should revalidate across deploys and rollbacks",
  );
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

Deno.test("timer state and saved documents still round-trip beside chat", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const initialState = {
      stocks: [{ id: "stock-1", name: "設計" }],
      timeline: [{
        id: "task-1",
        stockId: "stock-1",
        nameSnapshot: "設計",
        seconds: 1500,
      }],
    };
    const saveState = await handleRequest(
      new Request("http://localhost/api/state", {
        method: "PUT",
        body: JSON.stringify(initialState),
      }),
      { kv },
    );
    assert(saveState.status === 200, "timer state should save");

    const loadState = await handleRequest(
      new Request("http://localhost/api/state"),
      { kv },
    );
    assert(
      JSON.stringify((await loadState.json()).state) ===
        JSON.stringify(initialState),
      "the complete stock and timeline state should round-trip",
    );

    const createDocument = await handleRequest(
      new Request("http://localhost/api/documents", {
        method: "POST",
        body: JSON.stringify({ name: "集中プラン", state: initialState }),
      }),
      { kv },
    );
    assert(createDocument.status === 201, "a timer document should be created");
    const created = (await createDocument.json()).document;

    const updatedState = {
      stocks: [{ id: "stock-2", name: "レビュー" }],
      timeline: [{
        id: "task-2",
        stockId: "stock-2",
        nameSnapshot: "レビュー",
        seconds: 900,
      }],
    };
    const updateDocument = await handleRequest(
      new Request(`http://localhost/api/documents/${created.id}`, {
        method: "PUT",
        body: JSON.stringify({ name: "更新プラン", state: updatedState }),
      }),
      { kv },
    );
    assert(updateDocument.status === 200, "a timer document should update");

    const documents = await handleRequest(
      new Request("http://localhost/api/documents"),
      { kv },
    );
    const documentList = (await documents.json()).documents;
    assert(
      documentList.some((document: { id: string; name: string }) =>
        document.id === created.id && document.name === "更新プラン"
      ),
      "saved timer documents should be listed",
    );

    const loadedDocument = await handleRequest(
      new Request(`http://localhost/api/documents/${created.id}`),
      { kv },
    );
    const loaded = (await loadedDocument.json()).document;
    assert(
      loaded.name === "更新プラン" &&
        JSON.stringify(loaded.state) === JSON.stringify(updatedState),
      "the entire saved document should reopen after an update",
    );

    const chatHealth = await handleRequest(
      new Request("http://localhost/api/chat/health"),
      { kv },
    );
    assert(
      chatHealth.status === 200,
      "chat routing should remain available after timer document operations",
    );
  } finally {
    kv.close();
  }
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

Deno.test("chat notification API routes use the configured handler", async () => {
  const handledPaths: string[] = [];
  const dependencies = {
    chatNotificationHandler: (request: Request) => {
      handledPaths.push(new URL(request.url).pathname);
      return Promise.resolve(Response.json({ ok: true }, { status: 202 }));
    },
  };
  const room = "room-0000000000000001";
  const routes = [
    ["/api/chat/notifications", "GET"],
    [`/api/chat/rooms/${room}/read-position`, "POST"],
  ];
  for (const [path, method] of routes) {
    const response = await handleRequest(
      new Request(`http://localhost${path}`, { method }),
      dependencies,
    );
    assert(response.status === 202, "notification handler should be delegated");
  }
  assert(
    JSON.stringify(handledPaths) ===
      JSON.stringify(routes.map(([path]) => path)),
    "notification routes should be delegated",
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
