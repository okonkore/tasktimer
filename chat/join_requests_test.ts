import { ChatRepository, type JoinRequest } from "./data.ts";
import {
  ChatJoinRequestService,
  createChatJoinRequestHandler,
} from "./join_requests.ts";
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

interface JoinTestContext {
  repository: ChatRepository;
  roomHandler: (request: Request) => Promise<Response>;
  joinHandler: (request: Request) => Promise<Response>;
  login(email: string): Promise<Login>;
  createRoom(owner: Login): Promise<string>;
  setNow(value: string): void;
}

async function withJoinService(
  run: (context: JoinTestContext) => Promise<void>,
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
    generateToken: () => String.fromCharCode(65 + tokenIndex++).repeat(43),
  });
  const roomHandler = createChatRoomHandler(
    new ChatRoomService({
      repository,
      sessions,
      now: () => new Date(currentTime),
      generateRoomId: () => `room-${String(++roomIndex).padStart(16, "0")}`,
    }),
  );
  const joinHandler = createChatJoinRequestHandler(
    new ChatJoinRequestService({
      repository,
      sessions,
      now: () => new Date(currentTime),
    }),
  );

  try {
    await run({
      repository,
      roomHandler,
      joinHandler,
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
          { name: "Private planning", description: "Hidden details" },
        ));
        assert(response.status === 201, "test room should be created");
        return (await response.json()).room.id;
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
): Request {
  const options: RequestInit = {
    method: "POST",
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

Deno.test("unapproved users cannot read room contents and requests require authentication and CSRF", async () => {
  await withJoinService(
    async ({ roomHandler, joinHandler, login, createRoom }) => {
      const owner = await login("owner@example.com");
      const applicant = await login("applicant@example.com");
      const roomId = await createRoom(owner);
      const requestPath = `/api/chat/rooms/${roomId}/requests`;

      const unauthenticated = await joinHandler(request(requestPath, {
        method: "POST",
      }));
      assert(unauthenticated.status === 401, "join request must require login");

      const missingCsrf = await joinHandler(request(requestPath, {
        method: "POST",
        headers: { cookie: applicant.cookies },
      }));
      assert(missingCsrf.status === 403, "join request must require CSRF");

      const before = await roomHandler(request(`/api/chat/rooms/${roomId}`, {
        headers: { cookie: applicant.cookies },
      }));
      const beforeBody = await before.json();
      assert(before.status === 403, "non-member must not read the room");
      assert(!beforeBody.room, "room contents must not be returned");
      assert(
        !JSON.stringify(beforeBody).includes("Private planning") &&
          !JSON.stringify(beforeBody).includes("Hidden details"),
        "room name and description must remain private",
      );
      assert(
        beforeBody.access.status === "not-requested",
        "access response should allow a future UI to identify the state",
      );

      const submitted = await joinHandler(mutation(requestPath, applicant));
      assert(submitted.status === 201, "non-member should be able to apply");

      const whilePending = await roomHandler(
        request(`/api/chat/rooms/${roomId}`, {
          headers: { cookie: applicant.cookies },
        }),
      );
      const pendingBody = await whilePending.json();
      assert(whilePending.status === 403, "pending user must remain blocked");
      assert(
        pendingBody.access.status === "pending" && !pendingBody.room,
        "pending response must not include room contents",
      );

      const duplicate = await joinHandler(mutation(requestPath, applicant));
      assert(duplicate.status === 409, "duplicate pending request must fail");
    },
  );
});

Deno.test("only the owner can list and review pending requests without exposing email", async () => {
  await withJoinService(async ({ joinHandler, login, createRoom }) => {
    const owner = await login("owner@example.com");
    const applicant = await login("applicant@example.com");
    const other = await login("other@example.com");
    const roomId = await createRoom(owner);
    const requestPath = `/api/chat/rooms/${roomId}/requests`;
    await joinHandler(mutation(requestPath, applicant));

    const forbiddenList = await joinHandler(request(requestPath, {
      headers: { cookie: other.cookies },
    }));
    assert(forbiddenList.status === 403, "non-owner must not list requests");

    const listed = await joinHandler(request(requestPath, {
      headers: { cookie: owner.cookies },
    }));
    const listBody = await listed.json();
    assert(listed.status === 200, "owner should list pending requests");
    assert(listBody.requests.length === 1, "one request should be listed");
    assert(
      listBody.requests[0].applicant.id === applicant.userId,
      "the public applicant ID should be returned",
    );
    assert(
      !JSON.stringify(listBody).includes("applicant@example.com"),
      "applicant email must remain private",
    );

    const approvePath = `${requestPath}/${applicant.userId}/approve`;
    const forbiddenApproval = await joinHandler(
      mutation(approvePath, other, { role: "writer" }),
    );
    assert(
      forbiddenApproval.status === 403,
      "non-owner must not approve a request",
    );

    const rejectPath = `${requestPath}/${applicant.userId}/reject`;
    const forbiddenRejection = await joinHandler(
      mutation(rejectPath, other),
    );
    assert(
      forbiddenRejection.status === 403,
      "non-owner must not reject a request",
    );
  });
});

Deno.test("members can list display names and roles without exposing email", async () => {
  await withJoinService(async ({ joinHandler, login, createRoom }) => {
    const owner = await login("owner@example.com");
    const applicant = await login("applicant@example.com");
    const outsider = await login("outsider@example.com");
    const roomId = await createRoom(owner);
    const requestsPath = `/api/chat/rooms/${roomId}/requests`;
    const membersPath = `/api/chat/rooms/${roomId}/members`;
    await joinHandler(mutation(requestsPath, applicant));
    await joinHandler(mutation(
      `${requestsPath}/${applicant.userId}/approve`,
      owner,
      { role: "viewer" },
    ));

    const forbidden = await joinHandler(request(membersPath, {
      headers: { cookie: outsider.cookies },
    }));
    assert(forbidden.status === 403, "non-members cannot list members");

    const listed = await joinHandler(request(membersPath, {
      headers: { cookie: applicant.cookies },
    }));
    const body = await listed.json();
    assert(listed.status === 200, "approved members can list members");
    assert(body.members.length === 2, "owner and applicant should be listed");
    assert(
      body.members.some((member: { userId: string; role: string }) =>
        member.userId === applicant.userId && member.role === "viewer"
      ),
      "the current role should be returned",
    );
    assert(
      !JSON.stringify(body).includes("@example.com"),
      "member email addresses must remain private",
    );
  });
});

Deno.test("approval requires viewer or writer and atomically records visibleFrom", async () => {
  await withJoinService(async ({
    repository,
    roomHandler,
    joinHandler,
    login,
    createRoom,
    setNow,
  }) => {
    const owner = await login("owner@example.com");
    const applicant = await login("applicant@example.com");
    const roomId = await createRoom(owner);
    const requestPath = `/api/chat/rooms/${roomId}/requests`;
    await joinHandler(mutation(requestPath, applicant));
    const approvePath = `${requestPath}/${applicant.userId}/approve`;

    const noRole = await joinHandler(mutation(approvePath, owner, {}));
    assert(noRole.status === 400, "approval without a role must fail");
    const ownerRole = await joinHandler(
      mutation(approvePath, owner, { role: "owner" }),
    );
    assert(ownerRole.status === 400, "owner role must not be assignable");

    const missingCsrf = await joinHandler(request(approvePath, {
      method: "POST",
      headers: { cookie: owner.cookies },
      body: JSON.stringify({ role: "writer" }),
    }));
    assert(missingCsrf.status === 403, "approval must require CSRF");

    setNow("2026-07-19T15:30:00.000Z");
    const approved = await joinHandler(
      mutation(approvePath, owner, { role: "writer" }),
    );
    const approvedBody = await approved.json();
    assert(approved.status === 200, "owner should approve the request");
    assert(
      approvedBody.membership.role === "writer" &&
        approvedBody.membership.visibleFrom === "2026-07-19T15:30:00.000Z",
      "approval role and timestamp should be returned",
    );

    const [storedRequest, member] = await Promise.all([
      repository.getJoinRequest(roomId, applicant.userId),
      repository.getMember(roomId, applicant.userId),
    ]);
    assert(storedRequest?.status === "approved", "request must be approved");
    assert(member?.role === "writer", "writer membership must be created");
    assert(
      member?.visibleFrom === "2026-07-19T15:30:00.000Z",
      "visibleFrom must equal approval time",
    );

    const room = await roomHandler(request(`/api/chat/rooms/${roomId}`, {
      headers: { cookie: applicant.cookies },
    }));
    const roomBody = await room.json();
    assert(room.status === 200, "approved member should read the room");
    assert(
      roomBody.room.name === "Private planning" &&
        roomBody.membership.role === "writer",
      "room and membership should be available after approval",
    );

    const approvedAgain = await joinHandler(
      mutation(approvePath, owner, { role: "viewer" }),
    );
    assert(
      approvedAgain.status === 409,
      "approved request cannot be reviewed twice",
    );
  });
});

Deno.test("rejected users wait 24 hours before reapplying", async () => {
  await withJoinService(async ({
    repository,
    joinHandler,
    login,
    createRoom,
    setNow,
  }) => {
    const owner = await login("owner@example.com");
    const applicant = await login("applicant@example.com");
    const roomId = await createRoom(owner);
    const requestPath = `/api/chat/rooms/${roomId}/requests`;
    await joinHandler(mutation(requestPath, applicant));

    setNow("2026-07-19T13:00:00.000Z");
    const rejected = await joinHandler(mutation(
      `${requestPath}/${applicant.userId}/reject`,
      owner,
    ));
    const rejectedBody = await rejected.json();
    assert(rejected.status === 200, "owner should reject a pending request");
    assert(
      rejectedBody.request.rejectedUntil === "2026-07-20T13:00:00.000Z",
      "rejection should record the 24-hour boundary",
    );

    const blocked = await joinHandler(mutation(requestPath, applicant));
    const blockedBody = await blocked.json();
    assert(blocked.status === 429, "early reapplication must be blocked");
    assert(
      blockedBody.retryAt === "2026-07-20T13:00:00.000Z",
      "response should identify when reapplication is allowed",
    );

    setNow("2026-07-20T12:59:59.999Z");
    const stillBlocked = await joinHandler(mutation(requestPath, applicant));
    assert(stillBlocked.status === 429, "cooldown lasts the full 24 hours");

    setNow("2026-07-20T13:00:00.000Z");
    const reapplied = await joinHandler(mutation(requestPath, applicant));
    assert(reapplied.status === 201, "request is allowed at the boundary");
    const stored = await repository.getJoinRequest(roomId, applicant.userId);
    assert(stored?.status === "pending", "reapplication returns to pending");
    assert(stored.reviewedAt === null, "review timestamp should be reset");
    assert(stored.rejectedUntil === null, "cooldown should be reset");
    assert(
      stored.requestedAt === "2026-07-20T13:00:00.000Z",
      "reapplication should record a new request time",
    );
  });
});

Deno.test("removed users can reapply and concurrent submissions create one pending request", async () => {
  await withJoinService(async ({
    repository,
    joinHandler,
    login,
    createRoom,
    setNow,
  }) => {
    const owner = await login("owner@example.com");
    const removedUser = await login("removed@example.com");
    const concurrentUser = await login("concurrent@example.com");
    const roomId = await createRoom(owner);
    const removed: JoinRequest = {
      roomId,
      userId: removedUser.userId,
      status: "removed",
      requestedAt: "2026-07-18T10:00:00.000Z",
      reviewedAt: "2026-07-18T11:00:00.000Z",
      rejectedUntil: null,
      emailNotifiedAt: "2026-07-18T10:01:00.000Z",
    };
    await repository.setJoinRequest(removed);

    setNow("2026-07-19T16:00:00.000Z");
    const reapplied = await joinHandler(mutation(
      `/api/chat/rooms/${roomId}/requests`,
      removedUser,
    ));
    assert(reapplied.status === 201, "removed user should reapply immediately");
    const stored = await repository.getJoinRequest(roomId, removedUser.userId);
    assert(
      stored?.status === "pending",
      "removed state should return to pending",
    );
    assert(
      stored.emailNotifiedAt === null,
      "a new application must reset notification deduplication",
    );

    const path = `/api/chat/rooms/${roomId}/requests`;
    const responses = await Promise.all([
      joinHandler(mutation(path, concurrentUser)),
      joinHandler(mutation(path, concurrentUser)),
    ]);
    const statuses = responses.map((response) => response.status).sort();
    assert(
      JSON.stringify(statuses) === JSON.stringify([201, 409]),
      "atomic submission should accept exactly one concurrent request",
    );
  });
});
