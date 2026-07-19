import { ChatRepository } from "./data.ts";
import { ChatRoomService, createChatRoomHandler } from "./rooms.ts";
import {
  ChatSessionService,
  csrfCookieName,
  csrfHeaderName,
} from "./session.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function request(path: string, options: RequestInit = {}): Request {
  return new Request(`https://chat.example${path}`, options);
}

function cookieHeader(response: Response): string {
  return response.headers.getSetCookie()
    .map((cookie) => cookie.slice(0, cookie.indexOf(";")))
    .join("; ");
}

function cookieValue(cookies: string, name: string): string {
  const value = cookies.split(";").map((item) => item.trim()).find((item) =>
    item.startsWith(`${name}=`)
  );
  if (!value) throw new Error(`Missing ${name} cookie`);
  return value.slice(name.length + 1);
}

async function withRoomService(
  run: (context: {
    repository: ChatRepository;
    sessions: ChatSessionService;
    handler: (request: Request) => Promise<Response>;
    login(email: string): Promise<{ cookies: string; csrf: string }>;
  }) => Promise<void>,
): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  let userIndex = 0;
  let tokenIndex = 0;
  let roomIndex = 0;
  const repository = new ChatRepository(kv);
  const sessions = new ChatSessionService({
    repository,
    generateUserId: () => `user-${++userIndex}`,
    generateToken: () => String.fromCharCode(65 + tokenIndex++).repeat(43),
  });
  const service = new ChatRoomService({
    repository,
    sessions,
    generateRoomId: () => `room-${String(++roomIndex).padStart(16, "0")}`,
    now: () => new Date("2026-07-19T12:00:00.000Z"),
  });
  try {
    await run({
      repository,
      sessions,
      handler: createChatRoomHandler(service),
      login: async (email) => {
        const response = await sessions.completeOtpAuthentication(
          email,
          request("/api/chat/auth/verify-otp", { method: "POST" }),
        );
        const cookies = cookieHeader(response);
        return { cookies, csrf: cookieValue(cookies, csrfCookieName) };
      },
    });
  } finally {
    kv.close();
  }
}

function mutation(
  path: string,
  cookies: string,
  csrf: string,
  body: unknown,
  method = "POST",
): Request {
  return request(path, {
    method,
    headers: {
      cookie: cookies,
      origin: "https://chat.example",
      "content-type": "application/json",
      [csrfHeaderName]: csrf,
    },
    body: JSON.stringify(body),
  });
}

Deno.test("rooms require authentication and create an owner membership", async () => {
  await withRoomService(async ({ repository, handler, login }) => {
    const unauthenticated = await handler(request("/api/chat/rooms"));
    assert(unauthenticated.status === 401, "room list must require a session");

    const owner = await login("owner@example.com");
    const created = await handler(
      mutation("/api/chat/rooms", owner.cookies, owner.csrf, {
        name: "Planning room",
        description: "<b>Text only</b>",
      }),
    );
    assert(created.status === 201, "owner should be able to create a room");
    const body = await created.json();
    assert(
      /^[A-Za-z0-9_-]{16,64}$/.test(body.room.id),
      "room ID must be hard to guess",
    );
    assert(
      !JSON.stringify(body).includes("owner@example.com"),
      "room API must not expose email addresses",
    );
    const ownerMember = await repository.getMember(body.room.id, "user-1");
    assert(ownerMember?.role === "owner", "creator should be the owner member");

    const listed = await handler(request("/api/chat/rooms", {
      headers: { cookie: owner.cookies },
    }));
    const list = await listed.json();
    assert(
      list.ownedRooms.length === 1,
      "created room should be listed as owned",
    );
    assert(
      list.joinedRooms.length === 0,
      "owner room is not duplicated as joined",
    );
  });
});

Deno.test("only the owner can update a room and mutations require CSRF", async () => {
  await withRoomService(async ({ handler, login }) => {
    const owner = await login("owner@example.com");
    const created = await handler(
      mutation("/api/chat/rooms", owner.cookies, owner.csrf, {
        name: "Original",
        description: "Description",
      }),
    );
    const { room } = await created.json();
    const other = await login("other@example.com");

    const withoutCsrf = await handler(request(`/api/chat/rooms/${room.id}`, {
      method: "PATCH",
      headers: { cookie: owner.cookies, origin: "https://chat.example" },
      body: JSON.stringify({ name: "Changed", description: "Description" }),
    }));
    assert(withoutCsrf.status === 403, "room updates must require CSRF");

    const forbidden = await handler(mutation(
      `/api/chat/rooms/${room.id}`,
      other.cookies,
      other.csrf,
      { name: "Changed", description: "Description" },
      "PATCH",
    ));
    assert(forbidden.status === 403, "non-owner must not update a room");

    const updated = await handler(mutation(
      `/api/chat/rooms/${room.id}`,
      owner.cookies,
      owner.csrf,
      { name: "Changed", description: "Updated safely" },
      "PATCH",
    ));
    assert(updated.status === 200, "owner should be able to update a room");
    assert(
      (await updated.json()).room.name === "Changed",
      "new name should persist",
    );
  });
});

Deno.test("room creation enforces the 20 owned-room limit", async () => {
  await withRoomService(async ({ handler, login }) => {
    const owner = await login("owner@example.com");
    for (let index = 0; index < 20; index += 1) {
      const response = await handler(mutation(
        "/api/chat/rooms",
        owner.cookies,
        owner.csrf,
        { name: `Room ${index + 1}`, description: "" },
      ));
      assert(response.status === 201, "first 20 rooms should be accepted");
    }
    const overflow = await handler(mutation(
      "/api/chat/rooms",
      owner.cookies,
      owner.csrf,
      { name: "Overflow", description: "" },
    ));
    assert(overflow.status === 409, "21st owned room must be rejected");
  });
});
