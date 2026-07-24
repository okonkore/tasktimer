import {
  type ChatEvent,
  chatKeys,
  ChatRepository,
  type JoinRequest,
  type Member,
  type Message,
  type Notification,
  type ReadPosition,
} from "./data.ts";
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
    kv: Deno.Kv;
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
      kv,
      repository,
      sessions,
      handler: createChatRoomHandler(service),
      login: async (email) => {
        const response = await sessions.completeOtpAuthentication(
          email,
          request("/api/chat/auth/verify-otp", { method: "POST" }),
        );
        const body = await response.clone().json();
        await repository.updateUserProfile(
          body.user.id,
          { displayName: `User ${body.user.id}` },
          "2026-07-19T12:00:00.000Z",
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

Deno.test("chat mutations require initial display-name setup", async () => {
  await withRoomService(async ({ sessions, handler }) => {
    const login = await sessions.completeOtpAuthentication(
      "new-user@example.com",
      request("/api/chat/auth/verify-otp", { method: "POST" }),
    );
    const cookies = cookieHeader(login);
    const blocked = await handler(
      mutation(
        "/api/chat/rooms",
        cookies,
        cookieValue(cookies, csrfCookieName),
        { name: "Blocked room", description: "" },
      ),
    );
    assert(
      blocked.status === 409 &&
        (await blocked.json()).error === "Profile setup required",
      "a new user must set a display name before creating a room",
    );
  });
});

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

Deno.test("room deletion requires the owner, CSRF, and an exact room name", async () => {
  await withRoomService(async ({ handler, login }) => {
    const owner = await login("owner@example.com");
    const created = await handler(
      mutation("/api/chat/rooms", owner.cookies, owner.csrf, {
        name: "Planning room",
        description: "",
      }),
    );
    const { room } = await created.json();
    const other = await login("other@example.com");

    const noCsrf = await handler(request(`/api/chat/rooms/${room.id}`, {
      method: "DELETE",
      headers: {
        cookie: owner.cookies,
        origin: "https://chat.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ confirmationName: room.name }),
    }));
    assert(noCsrf.status === 403, "room deletion must require CSRF");

    const forbidden = await handler(mutation(
      `/api/chat/rooms/${room.id}`,
      other.cookies,
      other.csrf,
      { confirmationName: room.name },
      "DELETE",
    ));
    assert(forbidden.status === 403, "non-owner must not delete a room");

    const mismatch = await handler(mutation(
      `/api/chat/rooms/${room.id}`,
      owner.cookies,
      owner.csrf,
      { confirmationName: " planning room " },
      "DELETE",
    ));
    assert(mismatch.status === 400, "confirmation must match exactly");

    const stillThere = await handler(request(`/api/chat/rooms/${room.id}`, {
      headers: { cookie: owner.cookies },
    }));
    assert(stillThere.status === 200, "failed confirmation must keep the room");
  });
});

Deno.test("room deletion removes associated data and resumes safely", async () => {
  await withRoomService(async ({ kv, repository, handler, login }) => {
    const owner = await login("owner@example.com");
    const joined = await login("joined@example.com");
    const created = await handler(
      mutation("/api/chat/rooms", owner.cookies, owner.csrf, {
        name: "Large room",
        description: "",
      }),
    );
    const { room } = await created.json();
    const timestamp = "2026-07-19T12:00:00.000Z";
    const member: Member = {
      roomId: room.id,
      userId: "user-2",
      role: "writer",
      visibleFrom: timestamp,
      joinedAt: timestamp,
      updatedAt: timestamp,
    };
    const joinRequest: JoinRequest = {
      roomId: room.id,
      userId: "user-2",
      status: "approved",
      requestedAt: timestamp,
      reviewedAt: timestamp,
      rejectedUntil: null,
      emailNotifiedAt: timestamp,
    };
    const message: Message = {
      id: "01J00000000000000000000000",
      roomId: room.id,
      authorId: "user-2",
      body: "remove me",
      createdAt: timestamp,
      deletedAt: null,
      deletedBy: null,
    };
    const position: ReadPosition = {
      roomId: room.id,
      userId: "user-2",
      lastReadMessageId: message.id,
      updatedAt: timestamp,
    };
    const notification: Notification = {
      id: "notification-1",
      userId: "user-1",
      type: "join-request",
      roomId: room.id,
      actorId: "user-2",
      createdAt: timestamp,
      readAt: null,
      dedupeKey: null,
    };
    await repository.setMember(member);
    await repository.setJoinRequest(joinRequest);
    await repository.setMessage(message);
    await repository.setReadPosition(position);
    await repository.setNotification(notification);
    await kv.set(
      chatKeys.event("00000000000000000001"),
      {
        id: "00000000000000000001",
        type: "message-created",
        audience: "room-members",
        roomId: room.id,
        actorId: "user-2",
        targetUserId: null,
        createdAt: timestamp,
        payload: {},
      } satisfies ChatEvent,
    );

    // Simulate a request that made the room inaccessible but failed before
    // sweeping its large collections. A retry must resume from this marker.
    const roomEntry = await repository.getRoomEntry(room.id);
    assert(roomEntry.value && roomEntry.versionstamp, "room must exist");
    assert(
      await repository.beginRoomDeletion(
        roomEntry.value,
        roomEntry.versionstamp,
        timestamp,
      ),
      "deletion marker should be established",
    );

    const resumed = await handler(mutation(
      `/api/chat/rooms/${room.id}`,
      owner.cookies,
      owner.csrf,
      { confirmationName: room.name },
      "DELETE",
    ));
    assert(resumed.status === 200, "retry should finish partial deletion");
    const repeated = await handler(mutation(
      `/api/chat/rooms/${room.id}`,
      owner.cookies,
      owner.csrf,
      { confirmationName: room.name },
      "DELETE",
    ));
    assert(repeated.status === 200, "completed deletion should be idempotent");

    assert(await repository.getRoom(room.id) === null, "room must be gone");
    assert(
      await repository.getMember(room.id, "user-2") === null,
      "members must be removed",
    );
    assert(
      await repository.getJoinRequest(room.id, "user-2") === null,
      "join requests must be removed",
    );
    assert(
      await repository.getMessage(room.id, message.id) === null,
      "messages must be removed",
    );
    assert(
      await repository.getReadPosition(room.id, "user-2") === null,
      "read positions must be removed",
    );
    assert(
      (await kv.get(chatKeys.roomByMember("user-2", room.id))).value === null,
      "member index must be removed",
    );
    assert(
      (await kv.get(chatKeys.notification("user-1", notification.id))).value ===
        null,
      "room notifications must be removed",
    );
    assert(
      (await kv.get(chatKeys.event("00000000000000000001"))).value === null,
      "room events must be removed",
    );
    const inaccessible = await handler(request(
      `/api/chat/rooms/${room.id}`,
      { headers: { cookie: joined.cookies } },
    ));
    assert(inaccessible.status === 404, "deleted room must be inaccessible");
  });
});
