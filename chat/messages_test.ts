import {
  chatKeys,
  ChatRepository,
  createSortableId,
  type Message,
} from "./data.ts";
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

function request(path: string, options: RequestInit = {}): Request {
  return new Request(`https://chat.example${path}`, options);
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

interface Login {
  userId: string;
  cookies: string;
  csrf: string;
}

interface MessageTestContext {
  kv: Deno.Kv;
  repository: ChatRepository;
  messageHandler: (request: Request) => Promise<Response>;
  login(email: string): Promise<Login>;
  createRoom(owner: Login): Promise<string>;
  addMember(roomId: string, login: Login, role: "viewer" | "writer"): Promise<
    void
  >;
  setNow(value: string): void;
}

async function withMessageService(
  run: (context: MessageTestContext) => Promise<void>,
): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  const repository = new ChatRepository(kv);
  let currentTime = new Date("2026-07-19T12:00:00.000Z");
  let userIndex = 0;
  let tokenIndex = 0;
  let roomIndex = 0;
  const sessions = new ChatSessionService({
    repository,
    now: () => new Date(currentTime),
    generateUserId: () => `user-${++userIndex}`,
    generateToken: () => String(++tokenIndex).padStart(43, "A"),
  });
  const roomHandler = createChatRoomHandler(
    new ChatRoomService({
      repository,
      sessions,
      now: () => new Date(currentTime),
      generateRoomId: () => `room-${String(++roomIndex).padStart(16, "0")}`,
    }),
  );
  const messageHandler = createChatMessageHandler(
    new ChatMessageService({
      repository,
      sessions,
      now: () => new Date(currentTime),
    }),
  );

  try {
    await run({
      kv,
      repository,
      messageHandler,
      setNow(value) {
        currentTime = new Date(value);
      },
      async login(email) {
        const response = await sessions.completeOtpAuthentication(
          email,
          request("/api/chat/auth/verify-otp", { method: "POST" }),
        );
        const body = await response.json();
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
          { name: "Private room", description: "" },
        ));
        assert(response.status === 201, "test room should be created");
        return (await response.json()).room.id;
      },
      async addMember(roomId, login, role) {
        const timestamp = currentTime.toISOString();
        await repository.setMember({
          roomId,
          userId: login.userId,
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

function mutation(
  path: string,
  login: Login,
  body?: unknown,
  method = "POST",
): Request {
  const options: RequestInit = {
    method,
    headers: {
      cookie: login.cookies,
      origin: "https://chat.example",
      [csrfHeaderName]: login.csrf,
    },
  };
  if (body !== undefined) {
    (options.headers as Record<string, string>)["content-type"] =
      "application/json";
    options.body = JSON.stringify(body);
  }
  return request(path, options);
}

function authenticated(path: string, login: Login): Request {
  return request(path, { headers: { cookie: login.cookies } });
}

Deno.test("message APIs require current membership, CSRF, and writer permission", async () => {
  await withMessageService(async (
    { messageHandler, login, createRoom, addMember },
  ) => {
    const owner = await login("owner@example.com");
    const viewer = await login("viewer@example.com");
    const writer = await login("writer@example.com");
    const outsider = await login("outsider@example.com");
    const roomId = await createRoom(owner);
    await addMember(roomId, viewer, "viewer");
    await addMember(roomId, writer, "writer");
    const path = `/api/chat/rooms/${roomId}/messages`;

    const unauthenticated = await messageHandler(request(path));
    assert(unauthenticated.status === 401, "history must require login");

    const outsiderHistory = await messageHandler(authenticated(path, outsider));
    assert(outsiderHistory.status === 403, "outsiders must not read history");

    const missingCsrf = await messageHandler(request(path, {
      method: "POST",
      headers: { cookie: writer.cookies },
      body: JSON.stringify({ body: "hello" }),
    }));
    assert(missingCsrf.status === 403, "sending must require CSRF");

    const viewerSend = await messageHandler(
      mutation(path, viewer, { body: "forbidden" }),
    );
    assert(viewerSend.status === 403, "viewers must not send messages");

    const outsiderSend = await messageHandler(
      mutation(path, outsider, { body: "forbidden" }),
    );
    assert(outsiderSend.status === 403, "outsiders must not send messages");

    const body = "<b>plain text</b>\nsecond line";
    const sent = await messageHandler(mutation(path, writer, { body }));
    const sentBody = await sent.json();
    assert(sent.status === 201, "writers should send messages");
    assert(sentBody.message.body === body, "message text must be preserved");

    const history = await messageHandler(authenticated(path, viewer));
    const historyBody = await history.json();
    assert(history.status === 200, "viewers should read message history");
    assert(
      historyBody.messages[0].body === body,
      "history should return the persisted text without interpreting HTML",
    );
  });
});

Deno.test("message body validation enforces non-whitespace 1-2000 character text", async () => {
  await withMessageService(async (
    { messageHandler, login, createRoom, addMember },
  ) => {
    const owner = await login("owner@example.com");
    const writer = await login("writer@example.com");
    const roomId = await createRoom(owner);
    await addMember(roomId, writer, "writer");
    const path = `/api/chat/rooms/${roomId}/messages`;

    for (const value of ["", " \n\t", "a".repeat(2_001)]) {
      const response = await messageHandler(
        mutation(path, writer, { body: value }),
      );
      assert(response.status === 400, "invalid message text must be rejected");
    }
    const extraField = await messageHandler(
      mutation(path, writer, { body: "hello", admin: true }),
    );
    assert(extraField.status === 400, "unknown input fields must be rejected");

    const exactLimit = await messageHandler(
      mutation(path, writer, { body: "😀".repeat(2_000) }),
    );
    assert(
      exactLimit.status === 201,
      "2,000 Unicode characters should be accepted",
    );
    const aboveLimit = await messageHandler(
      mutation(path, writer, { body: "😀".repeat(2_001) }),
    );
    assert(
      aboveLimit.status === 400,
      "more than 2,000 Unicode characters should be rejected",
    );
  });
});

Deno.test("history pages contain only messages at or after visibleFrom", async () => {
  await withMessageService(async (
    { repository, messageHandler, login, createRoom, addMember, setNow },
  ) => {
    const owner = await login("owner@example.com");
    const viewer = await login("viewer@example.com");
    const roomId = await createRoom(owner);

    const oldMessages = Array.from({ length: 3 }, (_, index) =>
      fixtureMessage(
        roomId,
        owner.userId,
        `2026-07-19T12:0${index}:00.000Z`,
        `old-${index}`,
      ));
    for (const message of oldMessages) await repository.setMessage(message);

    setNow("2026-07-19T12:10:00.000Z");
    await addMember(roomId, viewer, "viewer");
    const visibleMessages = Array.from({ length: 55 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 6, 19, 12, 10, index));
      return fixtureMessage(
        roomId,
        owner.userId,
        date.toISOString(),
        `visible-${index}`,
      );
    });
    for (const message of visibleMessages) await repository.setMessage(message);

    const path = `/api/chat/rooms/${roomId}/messages`;
    const first = await messageHandler(authenticated(path, viewer));
    const firstBody = await first.json();
    assert(first.status === 200, "approved viewer should load history");
    assert(firstBody.messages.length === 50, "first page should have 50 items");
    assert(
      firstBody.messages.every((message: Message) =>
        message.createdAt >= "2026-07-19T12:10:00.000Z" &&
        !message.body?.startsWith("old-")
      ),
      "the first page must enforce visibleFrom",
    );
    assert(firstBody.nextBefore, "another page should expose a cursor");

    const second = await messageHandler(authenticated(
      `${path}?before=${firstBody.nextBefore}`,
      viewer,
    ));
    const secondBody = await second.json();
    assert(secondBody.messages.length === 5, "second page should have 5 items");
    assert(secondBody.nextBefore === null, "the last page should end paging");
    assert(
      secondBody.messages.every((message: Message) =>
        message.createdAt >= "2026-07-19T12:10:00.000Z" &&
        !message.body?.startsWith("old-")
      ),
      "paging must never cross visibleFrom",
    );

    const invalidCursor = await messageHandler(authenticated(
      `${path}?before=not-a-message-id`,
      viewer,
    ));
    assert(invalidCursor.status === 400, "invalid cursors must be rejected");
  });
});

Deno.test("message deletion is limited to the author and owner and erases the body", async () => {
  await withMessageService(async (
    { repository, messageHandler, login, createRoom, addMember },
  ) => {
    const owner = await login("owner@example.com");
    const author = await login("author@example.com");
    const otherWriter = await login("other@example.com");
    const roomId = await createRoom(owner);
    const otherRoomId = await createRoom(owner);
    await addMember(roomId, author, "writer");
    await addMember(roomId, otherWriter, "writer");
    await addMember(otherRoomId, author, "writer");
    const path = `/api/chat/rooms/${roomId}/messages`;

    const sent = await messageHandler(
      mutation(path, author, { body: "secret body" }),
    );
    const sentBody = await sent.json();
    const messageId = sentBody.message.id;

    const crossRoom = await messageHandler(mutation(
      `/api/chat/rooms/${otherRoomId}/messages/${messageId}`,
      author,
      undefined,
      "DELETE",
    ));
    assert(
      crossRoom.status === 404,
      "message IDs must be scoped to their room",
    );

    const otherDelete = await messageHandler(mutation(
      `${path}/${messageId}`,
      otherWriter,
      undefined,
      "DELETE",
    ));
    assert(otherDelete.status === 403, "other writers cannot delete a message");

    const ownerDelete = await messageHandler(mutation(
      `${path}/${messageId}`,
      owner,
      undefined,
      "DELETE",
    ));
    const deletedBody = await ownerDelete.json();
    assert(ownerDelete.status === 200, "the owner can delete every message");
    assert(
      deletedBody.message.body === null && deletedBody.message.deletedAt,
      "the response should mark the message as deleted",
    );

    const stored = await repository.getMessage(roomId, messageId);
    assert(stored?.body === null, "deleted message text must not remain in KV");
    assert(
      stored?.deletedBy === owner.userId,
      "the deletion actor should be retained",
    );

    const ownMessage = await messageHandler(
      mutation(path, author, { body: "author can remove this" }),
    );
    const ownMessageBody = await ownMessage.json();
    const authorDelete = await messageHandler(mutation(
      `${path}/${ownMessageBody.message.id}`,
      author,
      undefined,
      "DELETE",
    ));
    assert(authorDelete.status === 200, "authors can delete their own message");
  });
});

Deno.test("role changes, removal, and reapproval visibility apply immediately", async () => {
  await withMessageService(async (
    { kv, repository, messageHandler, login, createRoom, addMember, setNow },
  ) => {
    const owner = await login("owner@example.com");
    const member = await login("member@example.com");
    const roomId = await createRoom(owner);
    await addMember(roomId, member, "writer");
    const path = `/api/chat/rooms/${roomId}/messages`;

    const sent = await messageHandler(
      mutation(path, member, { body: "before role change" }),
    );
    const sentBody = await sent.json();
    assert(sent.status === 201, "writer should initially send");

    const existing = await repository.getMember(roomId, member.userId);
    assert(existing, "test member should exist");
    await repository.setMember({ ...existing, role: "viewer" });
    const viewerSend = await messageHandler(
      mutation(path, member, { body: "blocked" }),
    );
    assert(
      viewerSend.status === 403,
      "downgrade must block sending immediately",
    );
    const viewerDelete = await messageHandler(mutation(
      `${path}/${sentBody.message.id}`,
      member,
      undefined,
      "DELETE",
    ));
    assert(
      viewerDelete.status === 403,
      "viewers cannot delete their earlier messages",
    );

    await kv.delete(chatKeys.member(roomId, member.userId));
    const removedHistory = await messageHandler(authenticated(path, member));
    assert(
      removedHistory.status === 403,
      "removed members lose history access",
    );
    const removedSend = await messageHandler(
      mutation(path, member, { body: "blocked" }),
    );
    assert(removedSend.status === 403, "removed members cannot send");

    setNow("2026-07-19T13:00:00.000Z");
    await addMember(roomId, member, "writer");
    const reapprovedHistory = await messageHandler(
      authenticated(path, member),
    );
    const reapprovedBody = await reapprovedHistory.json();
    assert(
      reapprovedBody.messages.length === 0,
      "reapproval must not reveal the earlier membership's messages",
    );
    const hiddenDelete = await messageHandler(mutation(
      `${path}/${sentBody.message.id}`,
      member,
      undefined,
      "DELETE",
    ));
    assert(
      hiddenDelete.status === 404,
      "a guessed pre-reapproval message ID must remain inaccessible",
    );
  });
});

function fixtureMessage(
  roomId: string,
  authorId: string,
  createdAt: string,
  body: string,
): Message {
  return {
    id: createSortableId(new Date(createdAt)),
    roomId,
    authorId,
    body,
    createdAt,
    deletedAt: null,
    deletedBy: null,
  };
}
