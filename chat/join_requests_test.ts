import { ChatRepository, type JoinRequest } from "./data.ts";
import {
  ChatJoinRequestService,
  createChatJoinRequestHandler,
  type JoinRequestMail,
  ResendJoinRequestMailer,
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

function mailCount(mails: JoinRequestMail[]): number {
  return mails.length;
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
  sentMails: JoinRequestMail[];
  setMailFailure(value: boolean): void;
}

interface JoinTestOptions {
  publicOrigin?: string;
}

async function withJoinService(
  run: (context: JoinTestContext) => Promise<void>,
  options: JoinTestOptions = { publicOrigin: "https://public.example" },
): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  const repository = new ChatRepository(kv);
  let currentTime = new Date("2026-07-19T12:00:00.000Z");
  let userIndex = 0;
  let tokenIndex = 0;
  let roomIndex = 0;
  let mailFailure = false;
  const sentMails: JoinRequestMail[] = [];
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
      mailer: {
        sendJoinRequest(mail) {
          sentMails.push(mail);
          return mailFailure
            ? Promise.reject(new Error("delivery unavailable"))
            : Promise.resolve();
        },
      },
      publicOrigin: options.publicOrigin,
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
      sentMails,
      setMailFailure(value) {
        mailFailure = value;
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

Deno.test("join requests enforce ten submissions per user per day", async () => {
  await withJoinService(async (
    { joinHandler, login, createRoom },
  ) => {
    const owner = await login("many-rooms-owner@example.com");
    const applicant = await login("limited-applicant@example.com");
    const roomIds: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      roomIds.push(await createRoom(owner));
    }
    for (const roomId of roomIds.slice(0, 10)) {
      const response = await joinHandler(mutation(
        `/api/chat/rooms/${roomId}/requests`,
        applicant,
      ));
      assert(response.status === 201, "the first ten requests should pass");
    }
    const limited = await joinHandler(mutation(
      `/api/chat/rooms/${roomIds[10]}/requests`,
      applicant,
    ));
    const body = await limited.json();
    assert(limited.status === 429, "the eleventh request must be limited");
    assert(
      body.retryAt === "2026-07-20T12:00:00.000Z",
      "the response should include the next allowed time",
    );
    assert(
      limited.headers.get("retry-after") === "86400",
      "the response should include Retry-After",
    );
  });
});

Deno.test("room approval atomically enforces the one-hundred-member limit", async () => {
  await withJoinService(async (
    { repository, joinHandler, login, createRoom },
  ) => {
    const owner = await login("capacity-owner@example.com");
    const finalMember = await login("member-100@example.com");
    const overflow = await login("member-101@example.com");
    const roomId = await createRoom(owner);
    const requestsPath = `/api/chat/rooms/${roomId}/requests`;
    await joinHandler(mutation(requestsPath, finalMember));
    await joinHandler(mutation(requestsPath, overflow));
    const timestamp = "2026-07-19T12:00:00.000Z";
    for (let index = 0; index < 98; index += 1) {
      await repository.setMember({
        roomId,
        userId: `existing-${index}`,
        role: "viewer",
        visibleFrom: timestamp,
        joinedAt: timestamp,
        updatedAt: timestamp,
      });
    }

    const [first, second] = await Promise.all([
      joinHandler(mutation(
        `${requestsPath}/${finalMember.userId}/approve`,
        owner,
        { role: "viewer" },
      )),
      joinHandler(mutation(
        `${requestsPath}/${overflow.userId}/approve`,
        owner,
        { role: "writer" },
      )),
    ]);
    const [approved, full] = [first, second].sort((left, right) =>
      left.status - right.status
    );
    assert(approved.status === 200, "one hundredth member should be approved");
    const body = await full.json();
    assert(full.status === 409, "the hundred-and-first member must be refused");
    assert(body.limit === 100, "the capacity response should state the limit");
    assert(body.retryAt === null, "capacity has no predictable retry time");
    assert(
      await repository.countMembers(roomId) === 100,
      "concurrent approvals must never exceed room capacity",
    );
    const acceptedApplicants = [
      await repository.getMember(roomId, finalMember.userId),
      await repository.getMember(roomId, overflow.userId),
    ].filter(Boolean);
    assert(
      acceptedApplicants.length === 1,
      "exactly one concurrent applicant may gain membership",
    );
  });
});

Deno.test("a join request notifies an enabled owner once without exposing email in mail content", async () => {
  await withJoinService(async (
    { repository, joinHandler, login, createRoom, sentMails },
  ) => {
    const owner = await login("owner@example.com");
    const applicant = await login("applicant@example.com");
    await repository.updateUserDisplayName(
      owner.userId,
      "オーナー",
      "2026-07-19T12:00:00.000Z",
    );
    await repository.updateUserDisplayName(
      applicant.userId,
      "申請者 太郎",
      "2026-07-19T12:00:00.000Z",
    );
    const roomId = await createRoom(owner);
    const path = `/api/chat/rooms/${roomId}/requests`;

    const submitted = await joinHandler(mutation(path, applicant));
    assert(submitted.status === 201, "application should be saved");
    assert(sentMails.length === 1, "one application should send one email");
    const mail = sentMails[0];
    assert(mail.to === "owner@example.com", "only the owner receives mail");
    assert(mail.roomName === "Private planning", "mail names the room");
    assert(
      mail.applicantDisplayName === "申請者 太郎",
      "mail uses the applicant display name",
    );
    assert(
      mail.managementUrl ===
        `https://public.example/chat/rooms/${roomId}/members`,
      "mail must use the configured public origin rather than the request host",
    );
    assert(
      !JSON.stringify({ ...mail, to: undefined }).includes("@example.com"),
      "mail content must not contain email addresses",
    );
    assert(
      (await repository.getJoinRequest(roomId, applicant.userId))
        ?.emailNotifiedAt !== null,
      "successful notification should be recorded",
    );

    const duplicate = await joinHandler(mutation(path, applicant));
    assert(duplicate.status === 409, "same pending request should be rejected");
    assert(
      sentMails.length === 1,
      "a duplicate request must not send another email",
    );
  });
});

Deno.test("join-request mail is not sent without a valid configured public origin", async () => {
  await withJoinService(
    async ({ repository, joinHandler, login, createRoom, sentMails }) => {
      const owner = await login("owner@example.com");
      const applicant = await login("applicant@example.com");
      const roomId = await createRoom(owner);
      const submitted = await joinHandler(mutation(
        `/api/chat/rooms/${roomId}/requests`,
        applicant,
      ));
      assert(
        submitted.status === 201,
        "request should be saved without email config",
      );
      assert(
        sentMails.length === 0,
        "unconfigured public origin must suppress mail",
      );
      assert(
        (await repository.getJoinRequest(roomId, applicant.userId))
          ?.emailNotifiedAt === null,
        "a suppressed notification must not consume its delivery claim",
      );
    },
    {},
  );
});

Deno.test("join-request mail rejects invalid public-origin configuration", async () => {
  await withJoinService(
    async ({ joinHandler, login, createRoom, sentMails }) => {
      const owner = await login("owner@example.com");
      const applicant = await login("applicant@example.com");
      const roomId = await createRoom(owner);
      const submitted = await joinHandler(mutation(
        `/api/chat/rooms/${roomId}/requests`,
        applicant,
      ));
      assert(
        submitted.status === 201,
        "request should be saved with bad email config",
      );
      assert(
        sentMails.length === 0,
        "invalid public origin must suppress mail",
      );
    },
    { publicOrigin: "https://attacker.example/untrusted-path" },
  );
});

Deno.test("disabled owners receive no join-request email and delivery failures keep the request", async () => {
  await withJoinService(async (
    {
      repository,
      joinHandler,
      login,
      createRoom,
      sentMails,
      setMailFailure,
    },
  ) => {
    const disabledOwner = await login("disabled-owner@example.com");
    const firstApplicant = await login("first@example.com");
    const enabledOwner = await login("enabled-owner@example.com");
    const secondApplicant = await login("second@example.com");
    await repository.updateUserProfile(
      disabledOwner.userId,
      { emailNotificationsEnabled: false },
      "2026-07-19T12:00:00.000Z",
    );
    const disabledRoom = await createRoom(disabledOwner);
    const disabledResponse = await joinHandler(mutation(
      `/api/chat/rooms/${disabledRoom}/requests`,
      firstApplicant,
    ));
    assert(disabledResponse.status === 201, "request should be saved when off");
    assert(
      mailCount(sentMails) === 0,
      "disabled owners should not receive mail",
    );
    assert(
      (await repository.getJoinRequest(disabledRoom, firstApplicant.userId))
        ?.emailNotifiedAt === null,
      "disabled notification should not claim a delivery",
    );

    const enabledRoom = await createRoom(enabledOwner);
    setMailFailure(true);
    const failedDelivery = await joinHandler(mutation(
      `/api/chat/rooms/${enabledRoom}/requests`,
      secondApplicant,
    ));
    assert(
      failedDelivery.status === 201,
      "delivery failure must not roll back the join request",
    );
    assert(
      mailCount(sentMails) === 1,
      "enabled owner should get one delivery attempt",
    );
    assert(
      (await repository.getJoinRequest(enabledRoom, secondApplicant.userId))
        ?.emailNotifiedAt !== null,
      "failed delivery is claimed to prevent duplicate retry emails",
    );
  });
});

Deno.test("Resend join-request mail contains only the intended notification fields", async () => {
  const capturedRequests: Request[] = [];
  const mailer = new ResendJoinRequestMailer({
    apiKey: "resend-test-key",
    from: "Paradise Timer <notify@example.com>",
    fetcher: (input, init) => {
      capturedRequests.push(new Request(input, init));
      return Promise.resolve(new Response(null, { status: 200 }));
    },
  });
  await mailer.sendJoinRequest({
    to: "owner@example.com",
    roomName: "週次計画",
    applicantDisplayName: "申請者",
    managementUrl:
      "https://chat.example/chat/rooms/room-0000000000000001/members",
  });
  const request = capturedRequests[0];
  assert(request !== undefined, "Resend request should be made");
  assert(
    request.headers.get("authorization") === "Bearer resend-test-key",
    "Resend authorization should be used",
  );
  const payload = await request.json();
  assert(payload.to[0] === "owner@example.com", "recipient is sent separately");
  assert(
    payload.text.includes("週次計画") && payload.text.includes("申請者") &&
      payload.text.includes("/members"),
    "mail body should include room, applicant, and management link",
  );
  assert(
    !payload.text.includes("@example.com"),
    "mail body must not expose an email address",
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

Deno.test("only the owner can change member roles while preserving visibleFrom", async () => {
  await withJoinService(async ({
    repository,
    roomHandler,
    joinHandler,
    login,
    createRoom,
    setNow,
  }) => {
    const owner = await login("owner@example.com");
    const member = await login("member@example.com");
    const otherMember = await login("other@example.com");
    const roomId = await createRoom(owner);
    const requestsPath = `/api/chat/rooms/${roomId}/requests`;
    for (const applicant of [member, otherMember]) {
      await joinHandler(mutation(requestsPath, applicant));
      await joinHandler(mutation(
        `${requestsPath}/${applicant.userId}/approve`,
        owner,
        { role: "viewer" },
      ));
    }
    const original = await repository.getMember(roomId, member.userId);
    assert(original !== null, "approved membership should exist");
    const rolePath = `/api/chat/rooms/${roomId}/members/${member.userId}`;

    const missingCsrf = await joinHandler(request(rolePath, {
      method: "PATCH",
      headers: { cookie: owner.cookies },
      body: JSON.stringify({ role: "writer" }),
    }));
    assert(missingCsrf.status === 403, "role changes must require CSRF");

    const forbidden = await joinHandler(
      mutation(rolePath, otherMember, { role: "writer" }, "PATCH"),
    );
    assert(forbidden.status === 403, "non-owners cannot change roles");

    const invalid = await joinHandler(
      mutation(rolePath, owner, { role: "owner" }, "PATCH"),
    );
    assert(invalid.status === 400, "the owner role cannot be assigned");

    const ownerChange = await joinHandler(mutation(
      `/api/chat/rooms/${roomId}/members/${owner.userId}`,
      owner,
      { role: "viewer" },
      "PATCH",
    ));
    assert(ownerChange.status === 409, "the owner cannot lower their role");

    setNow("2026-07-19T14:00:00.000Z");
    const changed = await joinHandler(
      mutation(rolePath, owner, { role: "writer" }, "PATCH"),
    );
    const changedBody = await changed.json();
    assert(changed.status === 200, "the owner should change member roles");
    assert(
      changedBody.membership.role === "writer" &&
        changedBody.membership.visibleFrom === original.visibleFrom,
      "the response should return the new role and original visibility bound",
    );
    const stored = await repository.getMember(roomId, member.userId);
    assert(stored?.role === "writer", "the new role should be stored");
    assert(
      stored.visibleFrom === original.visibleFrom,
      "role changes must preserve visibleFrom",
    );
    assert(
      stored.updatedAt === "2026-07-19T14:00:00.000Z",
      "role changes should update the membership timestamp",
    );

    const room = await roomHandler(request(`/api/chat/rooms/${roomId}`, {
      headers: { cookie: member.cookies },
    }));
    const roomBody = await room.json();
    assert(
      room.status === 200 && roomBody.membership.role === "writer",
      "subsequent authorization reads should see the new role immediately",
    );
  });
});

Deno.test("only the owner can remove members and removed members can reapply", async () => {
  await withJoinService(async ({
    repository,
    roomHandler,
    joinHandler,
    login,
    createRoom,
    setNow,
  }) => {
    const owner = await login("owner@example.com");
    const member = await login("member@example.com");
    const otherMember = await login("other@example.com");
    const roomId = await createRoom(owner);
    const requestsPath = `/api/chat/rooms/${roomId}/requests`;
    for (const applicant of [member, otherMember]) {
      await joinHandler(mutation(requestsPath, applicant));
      await joinHandler(mutation(
        `${requestsPath}/${applicant.userId}/approve`,
        owner,
        { role: "viewer" },
      ));
    }
    const removePath = `/api/chat/rooms/${roomId}/members/${member.userId}`;

    const missingCsrf = await joinHandler(request(removePath, {
      method: "DELETE",
      headers: { cookie: owner.cookies },
    }));
    assert(missingCsrf.status === 403, "member removal must require CSRF");

    const forbidden = await joinHandler(
      mutation(removePath, otherMember, undefined, "DELETE"),
    );
    assert(forbidden.status === 403, "non-owners cannot remove members");

    const ownerRemoval = await joinHandler(mutation(
      `/api/chat/rooms/${roomId}/members/${owner.userId}`,
      owner,
      undefined,
      "DELETE",
    ));
    assert(ownerRemoval.status === 409, "the owner cannot remove themself");

    setNow("2026-07-19T15:00:00.000Z");
    const removed = await joinHandler(
      mutation(removePath, owner, undefined, "DELETE"),
    );
    const removedBody = await removed.json();
    assert(removed.status === 200, "the owner should remove another member");
    assert(
      removedBody.membership.status === "removed" &&
        removedBody.membership.removedAt === "2026-07-19T15:00:00.000Z",
      "the response should identify the removed member and timestamp",
    );

    const [storedMember, storedRequest, roomIds] = await Promise.all([
      repository.getMember(roomId, member.userId),
      repository.getJoinRequest(roomId, member.userId),
      repository.listRoomIdsByMember(member.userId),
    ]);
    assert(storedMember === null, "the membership should be deleted");
    assert(!roomIds.includes(roomId), "the membership index should be deleted");
    assert(
      storedRequest?.status === "removed" &&
        storedRequest.reviewedAt === "2026-07-19T15:00:00.000Z",
      "the join request should record the removed state",
    );

    const room = await roomHandler(request(`/api/chat/rooms/${roomId}`, {
      headers: { cookie: member.cookies },
    }));
    const roomBody = await room.json();
    assert(room.status === 403, "removed members immediately lose room access");
    assert(
      roomBody.access.status === "removed" && roomBody.access.canRequest,
      "removed members should be offered reapplication",
    );
    const members = await joinHandler(request(
      `/api/chat/rooms/${roomId}/members`,
      { headers: { cookie: member.cookies } },
    ));
    assert(members.status === 403, "removed members cannot list members");

    const reapplied = await joinHandler(mutation(requestsPath, member));
    assert(reapplied.status === 201, "removed members can reapply immediately");
    assert(
      (await repository.getJoinRequest(roomId, member.userId))?.status ===
        "pending",
      "reapplication should return the request to pending",
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
    sentMails,
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
      stored.emailNotifiedAt !== null,
      "a new application should receive its own notification claim",
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
    assert(
      sentMails.length === 2,
      "concurrent requests should add exactly one notification after the reapplication",
    );
  });
});
