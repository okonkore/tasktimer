import { type ChatEvent, ChatRepository } from "./data.ts";
import { ChatEventService, createChatEventHandler } from "./events.ts";
import {
  ChatJoinRequestService,
  createChatJoinRequestHandler,
} from "./join_requests.ts";
import { ChatMessageService, createChatMessageHandler } from "./messages.ts";
import { ChatRoomService, createChatRoomHandler } from "./rooms.ts";
import {
  ChatSessionService,
  csrfCookieName,
  csrfHeaderName,
} from "./session.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface Login {
  userId: string;
  cookies: string;
  csrf: string;
}

interface EventTestContext {
  kv: Deno.Kv;
  repository: ChatRepository;
  sessions: ChatSessionService;
  eventHandler: (request: Request) => Promise<Response>;
  joinHandler: (request: Request) => Promise<Response>;
  messageHandler: (request: Request) => Promise<Response>;
  login(email: string): Promise<Login>;
  createRoom(owner: Login): Promise<string>;
  addMember(roomId: string, member: Login, role: "viewer" | "writer"): Promise<
    void
  >;
}

async function withEventService(
  run: (context: EventTestContext) => Promise<void>,
): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  const repository = new ChatRepository(kv);
  let userIndex = 0;
  let tokenIndex = 0;
  let roomIndex = 0;
  const sessions = new ChatSessionService({
    repository,
    generateUserId: () => `user-${++userIndex}`,
    generateToken: () => String(++tokenIndex).padStart(43, "A"),
  });
  const roomHandler = createChatRoomHandler(
    new ChatRoomService({
      repository,
      sessions,
      generateRoomId: () => `room-${String(++roomIndex).padStart(16, "0")}`,
    }),
  );
  const joinHandler = createChatJoinRequestHandler(
    new ChatJoinRequestService({ repository, sessions }),
  );
  const messageHandler = createChatMessageHandler(
    new ChatMessageService({ repository, sessions }),
  );
  const eventHandler = createChatEventHandler(
    new ChatEventService({
      repository,
      sessions,
      pollIntervalMilliseconds: 10,
      heartbeatIntervalMilliseconds: 60_000,
    }),
  );

  try {
    await run({
      kv,
      repository,
      sessions,
      eventHandler,
      joinHandler,
      messageHandler,
      async login(email) {
        const response = await sessions.completeOtpAuthentication(
          email,
          request("/api/chat/auth/verify-otp", { method: "POST" }),
        );
        const body = await response.json();
        await repository.updateUserProfile(
          body.user.id,
          { displayName: `User ${body.user.id}` },
          new Date().toISOString(),
        );
        const cookies = cookieHeader(response);
        return {
          userId: body.user.id,
          cookies,
          csrf: cookieValue(cookies, csrfCookieName),
        };
      },
      async createRoom(owner) {
        const response = await roomHandler(mutation(
          "/api/chat/rooms",
          owner,
          { name: "Realtime room", description: "" },
        ));
        assert(response.status === 201, "room creation should succeed");
        return (await response.json()).room.id;
      },
      async addMember(roomId, member, role) {
        const timestamp = new Date().toISOString();
        await repository.setMember({
          roomId,
          userId: member.userId,
          role,
          visibleFrom: timestamp,
          joinedAt: timestamp,
          updatedAt: timestamp,
        });
      },
    });
  } finally {
    kv.close();
  }
}

Deno.test("event endpoint validates authentication, method, query, cursor, and SSE headers", async () => {
  await withEventService(async ({ eventHandler, login }) => {
    const user = await login("user@example.com");

    const unauthenticated = await eventHandler(request("/api/chat/events"));
    assert(unauthenticated.status === 401, "SSE must require authentication");

    const wrongMethod = await eventHandler(request("/api/chat/events", {
      method: "POST",
      headers: { cookie: user.cookies },
    }));
    assert(wrongMethod.status === 405, "SSE must only accept GET");
    assert(
      wrongMethod.headers.get("allow") === "GET",
      "GET must be advertised",
    );

    const unsupportedQuery = await eventHandler(authenticated(
      "/api/chat/events?roomId=secret",
      user,
    ));
    assert(unsupportedQuery.status === 400, "query cursors must be rejected");

    const malformedCursor = await eventHandler(request("/api/chat/events", {
      headers: {
        cookie: user.cookies,
        "last-event-id": "../../../other-user",
      },
    }));
    assert(malformedCursor.status === 400, "malformed cursor must be rejected");

    const controller = new AbortController();
    const response = await eventHandler(eventRequest(user, controller));
    assert(response.status === 200, "authenticated SSE should connect");
    assert(
      response.headers.get("content-type") ===
        "text/event-stream; charset=utf-8",
      "SSE content type must be explicit",
    );
    assert(
      response.headers.get("cache-control")?.includes("no-store"),
      "SSE must not be cached",
    );
    assert(
      response.headers.get("x-accel-buffering") === "no",
      "proxy buffering must be disabled",
    );
    controller.abort();
    await response.body?.cancel();
  });
});

Deno.test("persisted message events replay exactly after Last-Event-ID", async () => {
  await withEventService(async (
    { repository, eventHandler, messageHandler, login, createRoom, addMember },
  ) => {
    const owner = await login("owner@example.com");
    const viewer = await login("viewer@example.com");
    const roomId = await createRoom(owner);
    await addMember(roomId, viewer, "viewer");
    const path = `/api/chat/rooms/${roomId}/messages`;

    await messageHandler(mutation(path, owner, { body: "first" }));
    await messageHandler(mutation(path, owner, { body: "second" }));
    const persisted = await repository.listEventsAfter(
      "00000000000000000000",
    );
    assert(persisted.length === 2, "message and event writes must be atomic");
    assert(
      persisted[0].id < persisted[1].id,
      "persisted event IDs must be monotonic",
    );

    const firstController = new AbortController();
    const firstStream = await eventHandler(eventRequest(
      viewer,
      firstController,
      "00000000000000000000",
    ));
    const replay = await readEvents(firstStream, 2, firstController);
    assert(
      replay.map((event) => event.payload.body).join(",") === "first,second",
      "initial replay should preserve persisted order",
    );

    const reconnectController = new AbortController();
    const reconnect = await eventHandler(eventRequest(
      viewer,
      reconnectController,
      replay[0].id,
    ));
    const resumed = await readEvents(reconnect, 1, reconnectController);
    assert(
      resumed[0].id === replay[1].id,
      "reconnect must resume after cursor",
    );
  });
});

Deno.test("SSE filters room events and direct notifications by recipient", async () => {
  await withEventService(async (
    {
      repository,
      eventHandler,
      joinHandler,
      messageHandler,
      login,
      createRoom,
    },
  ) => {
    const owner = await login("owner@example.com");
    const applicant = await login("applicant@example.com");
    const roomId = await createRoom(owner);
    await messageHandler(mutation(
      `/api/chat/rooms/${roomId}/messages`,
      owner,
      { body: "members only" },
    ));

    const streamController = new AbortController();
    const stream = await eventHandler(eventRequest(
      applicant,
      streamController,
    ));
    const pendingRead = readEvents(stream, 1, streamController);
    const submitted = await joinHandler(mutation(
      `/api/chat/rooms/${roomId}/requests`,
      applicant,
    ));
    assert(submitted.status === 201, "join request should be submitted");
    const rejected = await joinHandler(mutation(
      `/api/chat/rooms/${roomId}/requests/${applicant.userId}/reject`,
      owner,
    ));
    assert(rejected.status === 200, "join request should be rejected");
    const received = await pendingRead;

    assert(
      received.length === 1 && received[0].type === "join-rejected",
      "applicant should only receive its direct rejection event",
    );
    const allEvents = await repository.listEventsAfter(
      "00000000000000000000",
    );
    assert(
      allEvents.some((event) => event.type === "message-created") &&
        allEvents.some((event) => event.type === "join-requested"),
      "filtered room and owner events should still exist in KV",
    );
  });
});

Deno.test("live SSE revalidates membership and stops room delivery after removal", async () => {
  await withEventService(async (
    {
      repository,
      eventHandler,
      joinHandler,
      messageHandler,
      login,
      createRoom,
      addMember,
    },
  ) => {
    const owner = await login("owner@example.com");
    const member = await login("member@example.com");
    const roomId = await createRoom(owner);
    await addMember(roomId, member, "writer");
    const existing = await repository.listEventsAfter(
      "00000000000000000000",
    );
    const cursor = existing.at(-1)?.id;
    const controller = new AbortController();
    const response = await eventHandler(
      eventRequest(member, controller, cursor),
    );
    assert(response.body, "SSE response must have a body");
    const reader = response.body.getReader();

    const changed = await joinHandler(mutation(
      `/api/chat/rooms/${roomId}/members/${member.userId}`,
      owner,
      { role: "viewer" },
      "PATCH",
    ));
    assert(changed.status === 200, "permission change should succeed");
    const permission = await readEventsFromReader(reader, 1);
    assert(
      permission[0].type === "permission-changed",
      "target should receive permission change",
    );

    const removed = await joinHandler(mutation(
      `/api/chat/rooms/${roomId}/members/${member.userId}`,
      owner,
      undefined,
      "DELETE",
    ));
    assert(removed.status === 200, "member removal should succeed");
    const removal = await readEventsFromReader(reader, 1);
    assert(
      removal[0].type === "member-removed",
      "target should receive its removal event",
    );

    await messageHandler(mutation(
      `/api/chat/rooms/${roomId}/messages`,
      owner,
      { body: "after removal" },
    ));
    const result = await Promise.race([
      readEventsFromReader(reader, 1).then(() => "event"),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 60)
      ),
    ]);
    assert(
      result === "timeout",
      "removed users must not receive later room events",
    );
    controller.abort();
    await reader.cancel();
  });
});

Deno.test("all chat mutations persist their matching realtime event", async () => {
  await withEventService(async (
    {
      repository,
      joinHandler,
      messageHandler,
      login,
      createRoom,
    },
  ) => {
    const owner = await login("owner@example.com");
    const approved = await login("approved@example.com");
    const rejected = await login("rejected@example.com");
    const roomId = await createRoom(owner);
    const requestsPath = `/api/chat/rooms/${roomId}/requests`;

    await joinHandler(mutation(requestsPath, approved));
    await joinHandler(mutation(
      `${requestsPath}/${approved.userId}/approve`,
      owner,
      { role: "viewer" },
    ));
    await joinHandler(mutation(
      `/api/chat/rooms/${roomId}/members/${approved.userId}`,
      owner,
      { role: "writer" },
      "PATCH",
    ));

    const messageResponse = await messageHandler(mutation(
      `/api/chat/rooms/${roomId}/messages`,
      approved,
      { body: "persist every mutation" },
    ));
    const messageId = (await messageResponse.json()).message.id;
    await messageHandler(mutation(
      `/api/chat/rooms/${roomId}/messages/${messageId}`,
      approved,
      undefined,
      "DELETE",
    ));
    await joinHandler(mutation(
      `/api/chat/rooms/${roomId}/members/${approved.userId}`,
      owner,
      undefined,
      "DELETE",
    ));

    await joinHandler(mutation(requestsPath, rejected));
    await joinHandler(mutation(
      `${requestsPath}/${rejected.userId}/reject`,
      owner,
    ));

    const eventTypes = (await repository.listEventsAfter(
      "00000000000000000000",
    )).map((event) => event.type);
    for (
      const expected of [
        "join-requested",
        "join-approved",
        "permission-changed",
        "message-created",
        "message-deleted",
        "member-removed",
        "join-rejected",
      ]
    ) {
      assert(
        eventTypes.includes(expected as ChatEvent["type"]),
        `${expected} should be persisted`,
      );
    }
  });
});

Deno.test("live SSE closes after its session is revoked", async () => {
  await withEventService(async ({ sessions, eventHandler, login }) => {
    const user = await login("user@example.com");
    const controller = new AbortController();
    const eventRequestValue = eventRequest(user, controller);
    const authenticatedUser = await sessions.authenticate(eventRequestValue);
    assert(authenticatedUser, "test session should authenticate");
    const response = await eventHandler(eventRequestValue);
    assert(response.body, "SSE response must have a body");
    const reader = response.body.getReader();
    await reader.read();

    await sessions.revoke(authenticatedUser);
    const closed = await Promise.race([
      reader.read().then((result) => result.done),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    assert(closed === true, "revoked sessions must close their SSE stream");
    controller.abort();
    await reader.cancel();
  });
});

function request(path: string, options: RequestInit = {}): Request {
  return new Request(`https://chat.example${path}`, options);
}

function authenticated(path: string, login: Login): Request {
  return request(path, { headers: { cookie: login.cookies } });
}

function eventRequest(
  login: Login,
  controller: AbortController,
  lastEventId?: string,
): Request {
  const headers: Record<string, string> = { cookie: login.cookies };
  if (lastEventId) headers["last-event-id"] = lastEventId;
  return request("/api/chat/events", {
    headers,
    signal: controller.signal,
  });
}

function mutation(
  path: string,
  login: Login,
  body?: unknown,
  method = "POST",
): Request {
  const headers: Record<string, string> = {
    cookie: login.cookies,
    origin: "https://chat.example",
    [csrfHeaderName]: login.csrf,
  };
  const options: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  return request(path, options);
}

function cookieHeader(response: Response): string {
  return response.headers.getSetCookie()
    .map((cookie) => cookie.slice(0, cookie.indexOf(";")))
    .join("; ");
}

function cookieValue(cookies: string, name: string): string {
  const prefix = `${name}=`;
  const value = cookies.split(";").map((item) => item.trim()).find((item) =>
    item.startsWith(prefix)
  );
  if (!value) throw new Error(`Missing cookie ${name}`);
  return value.slice(prefix.length);
}

async function readEvents(
  response: Response,
  count: number,
  controller: AbortController,
): Promise<ChatEvent[]> {
  assert(response.body, "SSE response must have a body");
  const reader = response.body.getReader();
  try {
    return await readEventsFromReader(reader, count);
  } finally {
    controller.abort();
    await reader.cancel();
  }
}

async function readEventsFromReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number,
): Promise<ChatEvent[]> {
  const decoder = new TextDecoder();
  const events: ChatEvent[] = [];
  let buffer = "";
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame.split("\n").find((line) => line.startsWith("data: "));
      if (data) events.push(JSON.parse(data.slice(6)) as ChatEvent);
    }
  }
  assert(events.length >= count, `expected ${count} SSE event(s)`);
  return events.slice(0, count);
}
