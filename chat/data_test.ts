import {
  chatKeys,
  ChatRepository,
  createSortableId,
  type Message,
  normalizeEmail,
  sortableIdLowerBound,
  type User,
} from "./data.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      `${message}: expected ${expectedJson}, received ${actualJson}`,
    );
  }
}

Deno.test("chat keys use an isolated namespace and normalized email", () => {
  assertEquals(
    normalizeEmail("  Ada@Example.COM "),
    "ada@example.com",
    "email should normalize",
  );
  assertEquals(
    chatKeys.userByEmail("  Ada@Example.COM "),
    ["chat", "usersByEmail", "ada@example.com"],
    "email index key should normalize",
  );

  const keys = [
    chatKeys.user("user-1"),
    chatKeys.userByEmail("ada@example.com"),
    chatKeys.otp("ada@example.com"),
    chatKeys.session("session-1"),
    chatKeys.room("room-1"),
    chatKeys.roomByOwner("user-1", "room-1"),
    chatKeys.member("room-1", "user-1"),
    chatKeys.request("room-1", "user-1"),
    chatKeys.message("room-1", "message-1"),
    chatKeys.readPosition("room-1", "user-1"),
    chatKeys.notification("user-1", "notification-1"),
    chatKeys.rateLimit("message", "user-1", "window-1"),
  ];
  assert(
    keys.every((key) => key[0] === "chat"),
    "all chat keys should share the chat namespace",
  );
  assert(
    new Set(keys.map((key) => JSON.stringify(key))).size === keys.length,
    "chat keys should be distinct",
  );

  const roomKey = JSON.stringify(chatKeys.room("room-1"));
  assert(
    roomKey !== JSON.stringify(["tasktimer", "documents", "room-1"]),
    "timer key must differ",
  );
  assert(
    roomKey !== JSON.stringify(["perfpad", "rooms", "room-1"]),
    "Perfpad key must differ",
  );
});

Deno.test("sortable IDs order by timestamp and expose a lower bound", () => {
  const firstDate = new Date("2026-07-19T00:00:00.000Z");
  const secondDate = new Date("2026-07-19T00:00:00.001Z");
  const first = createSortableId(firstDate);
  const second = createSortableId(secondDate);
  assert(first.length === 26, "sortable ID should have 26 characters");
  assert(
    first < second,
    "later timestamps should sort after earlier timestamps",
  );
  assert(
    sortableIdLowerBound(firstDate) <= first,
    "lower bound should include the timestamp",
  );
});

Deno.test("user repository maintains the email index atomically", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const repository = new ChatRepository(kv);
    const user: User = {
      id: "user-1",
      email: "Ada@Example.COM",
      displayName: "Ada",
      emailNotificationsEnabled: true,
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
      deletedAt: null,
    };

    assert(
      await repository.createUser(user),
      "first user creation should succeed",
    );
    assert(
      !(await repository.createUser({ ...user, id: "user-2" })),
      "duplicate email should fail",
    );
    const loaded = await repository.getUserByEmail(" ADA@example.com ");
    assert(loaded?.id === user.id, "email index should resolve the user");
    assert(
      loaded.email === "ada@example.com",
      "stored email should be normalized",
    );
  } finally {
    kv.close();
  }
});

Deno.test("message repository isolates rooms and paginates newest first", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const repository = new ChatRepository(kv);
    const timestamps = [
      "2026-07-19T00:00:00.000Z",
      "2026-07-19T00:01:00.000Z",
      "2026-07-19T00:02:00.000Z",
    ];
    const messages: Message[] = timestamps.map((createdAt, index) => ({
      id: createSortableId(new Date(createdAt)),
      roomId: "room-1",
      authorId: "user-1",
      body: `message-${index + 1}`,
      createdAt,
      deletedAt: null,
      deletedBy: null,
    }));
    for (const message of messages) await repository.setMessage(message);
    await repository.setMessage({
      ...messages[0],
      id: createSortableId(new Date(timestamps[2])),
      roomId: "room-2",
    });

    const firstPage = await repository.listMessages("room-1", { limit: 2 });
    assertEquals(
      firstPage.messages.map((message) => message.body),
      ["message-3", "message-2"],
      "first page should be newest first",
    );

    const secondPage = await repository.listMessages("room-1", {
      limit: 2,
      before: firstPage.nextBefore ?? undefined,
    });
    assertEquals(
      secondPage.messages.map((message) => message.body),
      ["message-1"],
      "second page should continue before the cursor",
    );

    const visiblePage = await repository.listMessages("room-1", {
      visibleFrom: timestamps[1],
    });
    assertEquals(
      visiblePage.messages.map((message) => message.body),
      ["message-3", "message-2"],
      "visibleFrom should exclude earlier messages",
    );
  } finally {
    kv.close();
  }
});
