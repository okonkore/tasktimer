import { ChatRepository, createSortableId, type Message } from "./data.ts";
import {
  ChatNotificationService,
  createChatNotificationHandler,
} from "./notifications.ts";
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
  return response.headers.getSetCookie().map((item) =>
    item.slice(0, item.indexOf(";"))
  ).join("; ");
}

function cookieValue(cookies: string, name: string): string {
  const value = cookies.split(";").map((item) => item.trim()).find((item) =>
    item.startsWith(`${name}=`)
  );
  if (!value) throw new Error(`Missing ${name} cookie`);
  return value.slice(name.length + 1);
}

interface Login {
  userId: string;
  cookies: string;
  csrf: string;
}

async function withNotifications(
  run: (context: {
    repository: ChatRepository;
    handler: (request: Request) => Promise<Response>;
    login(email: string): Promise<Login>;
  }) => Promise<void>,
): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  const repository = new ChatRepository(kv);
  let userNumber = 0;
  let tokenNumber = 0;
  const now = new Date("2026-07-23T00:00:00.000Z");
  const sessions = new ChatSessionService({
    repository,
    now: () => new Date(now),
    generateUserId: () => `user-${++userNumber}`,
    generateToken: () => String(++tokenNumber).padStart(43, "A"),
  });
  const handler = createChatNotificationHandler(
    new ChatNotificationService({
      repository,
      sessions,
      now: () => new Date(now),
    }),
  );
  try {
    await run({
      repository,
      handler,
      async login(email) {
        const response = await sessions.completeOtpAuthentication(
          email,
          request("/api/chat/auth/verify-otp", { method: "POST" }),
        );
        const body = await response.json();
        await repository.updateUserProfile(
          body.user.id,
          { displayName: `User ${body.user.id}` },
          now.toISOString(),
        );
        const cookies = cookieHeader(response);
        return {
          userId: body.user.id,
          cookies,
          csrf: cookieValue(cookies, csrfCookieName),
        };
      },
    });
  } finally {
    kv.close();
  }
}

function authenticated(path: string, login: Login): Request {
  return request(path, { headers: { cookie: login.cookies } });
}

function mutation(path: string, login: Login, body: unknown): Request {
  return request(path, {
    method: "POST",
    headers: {
      cookie: login.cookies,
      origin: "https://chat.example",
      "content-type": "application/json",
      [csrfHeaderName]: login.csrf,
    },
    body: JSON.stringify(body),
  });
}

async function setupRoom(
  repository: ChatRepository,
  owner: Login,
  writer: Login,
): Promise<{ roomId: string; beforeVisible: Message; newest: Message }> {
  const roomId = "room-0000000000000001";
  const beforeVisibleAt = "2026-07-23T00:00:00.000Z";
  const visibleFrom = "2026-07-23T00:01:00.000Z";
  const newestAt = "2026-07-23T00:02:00.000Z";
  await repository.setRoom({
    id: roomId,
    ownerId: owner.userId,
    name: "Private",
    description: "",
    createdAt: beforeVisibleAt,
    updatedAt: beforeVisibleAt,
  });
  await repository.setMember({
    roomId,
    userId: owner.userId,
    role: "owner",
    visibleFrom: beforeVisibleAt,
    joinedAt: beforeVisibleAt,
    updatedAt: beforeVisibleAt,
  });
  await repository.setMember({
    roomId,
    userId: writer.userId,
    role: "writer",
    visibleFrom,
    joinedAt: visibleFrom,
    updatedAt: visibleFrom,
  });
  const beforeVisible: Message = {
    id: createSortableId(new Date(beforeVisibleAt)),
    roomId,
    authorId: owner.userId,
    body: "before visible",
    createdAt: beforeVisibleAt,
    deletedAt: null,
    deletedBy: null,
  };
  const newest: Message = {
    id: createSortableId(new Date(newestAt)),
    roomId,
    authorId: owner.userId,
    body: "newest",
    createdAt: newestAt,
    deletedAt: null,
    deletedBy: null,
  };
  await repository.setMessage(beforeVisible);
  await repository.setMessage(newest);
  return { roomId, beforeVisible, newest };
}

Deno.test("notification summary counts only accessible messages and owner requests", async () => {
  await withNotifications(async ({ repository, handler, login }) => {
    const owner = await login("owner@example.com");
    const writer = await login("writer@example.com");
    const { roomId } = await setupRoom(repository, owner, writer);
    await repository.setJoinRequest({
      roomId,
      userId: "pending-user",
      status: "pending",
      requestedAt: "2026-07-23T00:02:00.000Z",
      reviewedAt: null,
      rejectedUntil: null,
      emailNotifiedAt: null,
    });

    const ownerResponse = await handler(authenticated(
      "/api/chat/notifications",
      owner,
    ));
    const ownerSummary = await ownerResponse.json();
    assert(ownerResponse.status === 200, "owner should see a summary");
    assert(ownerSummary.totalUnreadCount === 0, "own messages are not unread");
    assert(
      ownerSummary.totalPendingRequestCount === 1,
      "owners should see their pending request count",
    );

    const writerResponse = await handler(authenticated(
      "/api/chat/notifications",
      writer,
    ));
    const writerSummary = await writerResponse.json();
    assert(writerResponse.status === 200, "member should see a summary");
    assert(
      writerSummary.totalUnreadCount === 1,
      "visible messages from other authors should be unread",
    );
    assert(
      writerSummary.totalPendingRequestCount === 0,
      "non-owners must not learn request counts",
    );
  });
});

Deno.test("read positions require CSRF, membership, visibility, and only advance", async () => {
  await withNotifications(async ({ repository, handler, login }) => {
    const owner = await login("owner@example.com");
    const writer = await login("writer@example.com");
    const outsider = await login("outsider@example.com");
    const { roomId, beforeVisible, newest } = await setupRoom(
      repository,
      owner,
      writer,
    );
    const path = `/api/chat/rooms/${roomId}/read-position`;
    const missingCsrf = await handler(request(path, {
      method: "POST",
      headers: { cookie: writer.cookies, "content-type": "application/json" },
      body: JSON.stringify({ messageId: newest.id }),
    }));
    assert(missingCsrf.status === 403, "read updates require CSRF");

    const outsiderResponse = await handler(mutation(path, outsider, {
      messageId: newest.id,
    }));
    assert(outsiderResponse.status === 403, "outsiders must not set a marker");

    const inaccessible = await handler(mutation(path, writer, {
      messageId: beforeVisible.id,
    }));
    assert(
      inaccessible.status === 404,
      "pre-approval messages must stay hidden",
    );

    const saved = await handler(
      mutation(path, writer, { messageId: newest.id }),
    );
    assert(saved.status === 200, "visible messages should be markable as read");
    const afterRead = await handler(authenticated(
      "/api/chat/notifications",
      writer,
    ));
    assert(
      (await afterRead.json()).totalUnreadCount === 0,
      "marking the latest visible message should clear unread count",
    );
    const stale = await handler(mutation(path, writer, {
      messageId: createSortableId(new Date("2026-07-23T00:01:00.000Z")),
    }));
    assert(stale.status === 404, "unknown cursors must be rejected");
    const position = await repository.getReadPosition(roomId, writer.userId);
    assert(
      position?.lastReadMessageId === newest.id,
      "a rejected or stale update must not move the marker backward",
    );
  });
});
