import { createOtpAuthHandler, OtpAuthService, type OtpMail } from "./auth.ts";
import { ChatRepository } from "./data.ts";
import { ChatEventService, createChatEventHandler } from "./events.ts";
import {
  ChatJoinRequestService,
  createChatJoinRequestHandler,
  type JoinRequestMail,
} from "./join_requests.ts";
import { ChatMessageService, createChatMessageHandler } from "./messages.ts";
import {
  ChatNotificationService,
  createChatNotificationHandler,
} from "./notifications.ts";
import { ChatRoomService, createChatRoomHandler } from "./rooms.ts";
import {
  ChatSessionService,
  createSessionAuthHandler,
  csrfCookieName,
  csrfHeaderName,
  sessionCookieName,
} from "./session.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface Login {
  userId: string;
  cookies: string;
  csrf: string;
}

function request(path: string, options: RequestInit = {}): Request {
  return new Request(`https://chat.example${path}`, options);
}

function authenticated(path: string, login: Login): Request {
  return request(path, { headers: { cookie: login.cookies } });
}

function mutation(
  path: string,
  login: Login,
  body?: unknown,
  method = "POST",
): Request {
  return request(path, {
    method,
    headers: {
      cookie: login.cookies,
      origin: "https://chat.example",
      [csrfHeaderName]: login.csrf,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function loginCookies(response: Response): { cookies: string; csrf: string } {
  const pairs = response.headers.getSetCookie().map((cookie) =>
    cookie.slice(0, cookie.indexOf(";"))
  );
  const cookies = pairs.join("; ");
  const csrfPair = pairs.find((pair) => pair.startsWith(`${csrfCookieName}=`));
  assert(
    pairs.some((pair) => pair.startsWith(`${sessionCookieName}=`)),
    "login must issue a session cookie",
  );
  assert(csrfPair, "login must issue a CSRF cookie");
  return {
    cookies,
    csrf: csrfPair.slice(`${csrfCookieName}=`.length),
  };
}

Deno.test("multi-user chat flow integrates login, permissions, messages, SSE, and deletion", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const repository = new ChatRepository(kv);
    let currentTime = new Date("2026-07-24T00:00:00.000Z");
    let tokenIndex = 0;
    let userIndex = 0;
    const tokenCharacters =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const sessions = new ChatSessionService({
      repository,
      now: () => new Date(currentTime),
      generateToken: () => tokenCharacters[tokenIndex++].repeat(43),
      generateUserId: () => `integration-user-${++userIndex}`,
    });
    const otpCodes = ["111111", "222222", "333333"];
    const otpMail: OtpMail[] = [];
    const otpService = new OtpAuthService({
      repository,
      mailer: {
        sendOtp(mail) {
          otpMail.push(mail);
          return Promise.resolve();
        },
      },
      authSecret: "integration-auth-secret-that-is-longer-than-32-bytes",
      now: () => new Date(currentTime),
      generateCode: () => {
        const code = otpCodes[otpMail.length];
        assert(code, "a deterministic OTP should be available");
        return code;
      },
    });
    const otpHandler = createOtpAuthHandler(otpService, {
      onVerified: (email, verifiedRequest) =>
        sessions.completeOtpAuthentication(email, verifiedRequest),
      getClientIp: () => "192.0.2.10",
    });
    const sessionHandler = createSessionAuthHandler(sessions);
    const roomHandler = createChatRoomHandler(
      new ChatRoomService({
        repository,
        sessions,
        now: () => new Date(currentTime),
        generateRoomId: () => "integration-room-000001",
      }),
    );
    const joinMail: JoinRequestMail[] = [];
    const joinHandler = createChatJoinRequestHandler(
      new ChatJoinRequestService({
        repository,
        sessions,
        now: () => new Date(currentTime),
        publicOrigin: "https://chat.example",
        mailer: {
          sendJoinRequest(mail) {
            joinMail.push(mail);
            return Promise.resolve();
          },
        },
      }),
    );
    const messageHandler = createChatMessageHandler(
      new ChatMessageService({
        repository,
        sessions,
        now: () => new Date(currentTime),
      }),
    );
    const notificationHandler = createChatNotificationHandler(
      new ChatNotificationService({
        repository,
        sessions,
        now: () => new Date(currentTime),
      }),
    );
    const eventHandler = createChatEventHandler(
      new ChatEventService({
        repository,
        sessions,
        pollIntervalMilliseconds: 10,
        heartbeatIntervalMilliseconds: 60_000,
        now: () => new Date(currentTime),
      }),
    );

    const loginUser = async (
      email: string,
      code: string,
      displayName: string,
    ): Promise<Login> => {
      const requested = await otpHandler(
        request("/api/chat/auth/request-otp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email }),
        }),
      );
      assert(requested.status === 202, "OTP request should succeed");
      const verified = await otpHandler(
        request("/api/chat/auth/verify-otp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, code }),
        }),
      );
      assert(verified.status === 200, "OTP verification should succeed");
      const verifiedBody = await verified.clone().json();
      assert(
        verifiedBody.needsProfile === true,
        "first login should require a profile",
      );
      const loginData = {
        userId: verifiedBody.user.id,
        ...loginCookies(verified),
      };
      const profile = await sessionHandler(
        mutation("/api/chat/me", loginData, { displayName }, "PATCH"),
      );
      assert(profile.status === 200, "initial profile should save");
      return loginData;
    };

    const owner = await loginUser("owner@example.com", "111111", "Owner");
    const viewer = await loginUser("viewer@example.com", "222222", "Viewer");
    const writer = await loginUser("writer@example.com", "333333", "Writer");
    assert(otpMail.length === 3, "all users should receive their OTP");

    const created = await roomHandler(
      mutation(
        "/api/chat/rooms",
        owner,
        { name: "統合テスト", description: "複数ユーザーの検証" },
      ),
    );
    assert(created.status === 201, "owner should create a room");
    const roomId = (await created.json()).room.id;
    const messagePath = `/api/chat/rooms/${roomId}/messages`;
    const requestPath = `/api/chat/rooms/${roomId}/requests`;

    currentTime = new Date("2026-07-24T00:01:00.000Z");
    const hiddenMessage = await messageHandler(
      mutation(messagePath, owner, { body: "承認前の投稿" }),
    );
    assert(hiddenMessage.status === 201, "owner should post before approvals");

    currentTime = new Date("2026-07-24T00:02:00.000Z");
    assert(
      (await joinHandler(mutation(requestPath, viewer))).status === 201,
      "viewer should submit a join request",
    );
    assert(
      (await joinHandler(mutation(requestPath, writer))).status === 201,
      "writer should submit a join request",
    );
    assert(
      joinMail.length === 2 &&
        joinMail.every((mail) =>
          mail.managementUrl ===
            `https://chat.example/chat/rooms/${roomId}/members`
        ),
      "owner should receive one correctly scoped email for each request",
    );
    const pending = await messageHandler(authenticated(messagePath, viewer));
    assert(
      pending.status === 403,
      "approval-pending users must not read messages",
    );
    const ownerNotifications = await notificationHandler(
      authenticated("/api/chat/notifications", owner),
    );
    assert(
      (await ownerNotifications.json()).totalPendingRequestCount === 2,
      "owner notification summary should include both requests",
    );

    currentTime = new Date("2026-07-24T00:03:00.000Z");
    const viewerApproval = await joinHandler(
      mutation(
        `${requestPath}/${viewer.userId}/approve`,
        owner,
        { role: "viewer" },
      ),
    );
    assert(viewerApproval.status === 200, "viewer should be approved");
    currentTime = new Date("2026-07-24T00:04:00.000Z");
    const writerApproval = await joinHandler(
      mutation(
        `${requestPath}/${writer.userId}/approve`,
        owner,
        { role: "writer" },
      ),
    );
    assert(writerApproval.status === 200, "writer should be approved");

    const viewerHistory = await messageHandler(
      authenticated(messagePath, viewer),
    );
    assert(
      viewerHistory.status === 200 &&
        (await viewerHistory.json()).messages.length === 0,
      "members must not see messages from before their approval",
    );
    const viewerPost = await messageHandler(
      mutation(messagePath, viewer, { body: "権限を回避" }),
    );
    assert(
      viewerPost.status === 403,
      "viewer API calls must not bypass write permission",
    );

    const previousEventId = await repository.getLatestEventId();
    currentTime = new Date("2026-07-24T00:05:00.000Z");
    const writerPost = await messageHandler(
      mutation(messagePath, writer, { body: "承認後の投稿" }),
    );
    assert(writerPost.status === 201, "writer should post");
    const postedMessage = (await writerPost.json()).message;

    const controller = new AbortController();
    const eventResponse = await eventHandler(
      request("/api/chat/events", {
        headers: {
          cookie: viewer.cookies,
          "last-event-id": previousEventId,
        },
        signal: controller.signal,
      }),
    );
    assert(
      eventResponse.status === 200 && eventResponse.body,
      "approved viewer should connect to SSE",
    );
    const reader = eventResponse.body.getReader();
    const decoder = new TextDecoder();
    let eventText = "";
    for (let readCount = 0; readCount < 4; readCount += 1) {
      const result = await reader.read();
      if (result.done) break;
      eventText += decoder.decode(result.value);
      if (
        eventText.includes("event: message-created") &&
        eventText.includes(postedMessage.id)
      ) break;
    }
    controller.abort();
    await reader.cancel();
    assert(
      eventText.includes("event: message-created") &&
        eventText.includes(postedMessage.id),
      "SSE reconnect should replay the visible post after Last-Event-ID",
    );

    const viewerNotifications = await notificationHandler(
      authenticated("/api/chat/notifications", viewer),
    );
    assert(
      (await viewerNotifications.json()).totalUnreadCount === 1,
      "the writer's visible post should become unread for the viewer",
    );

    const renamed = await sessionHandler(
      mutation(
        "/api/chat/me",
        writer,
        { displayName: "Writer Renamed" },
        "PATCH",
      ),
    );
    assert(renamed.status === 200, "writer should rename their profile");
    const renamedHistory = await messageHandler(
      authenticated(messagePath, viewer),
    );
    const renamedMessages = (await renamedHistory.json()).messages;
    assert(
      renamedMessages[0].authorDisplayName === "Writer Renamed",
      "message history should resolve the author's current display name",
    );

    const downgrade = await joinHandler(
      mutation(
        `/api/chat/rooms/${roomId}/members/${writer.userId}`,
        owner,
        { role: "viewer" },
        "PATCH",
      ),
    );
    assert(downgrade.status === 200, "owner should change member permissions");
    assert(
      (await messageHandler(
        mutation(messagePath, writer, { body: "降格後の投稿" }),
      )).status === 403,
      "permission changes should take effect on the next API call",
    );

    const removal = await joinHandler(
      mutation(
        `/api/chat/rooms/${roomId}/members/${viewer.userId}`,
        owner,
        undefined,
        "DELETE",
      ),
    );
    assert(removal.status === 200, "owner should remove a member");
    assert(
      (await messageHandler(authenticated(messagePath, viewer))).status ===
        403,
      "removed users should immediately lose history access",
    );

    const deleted = await roomHandler(
      mutation(
        `/api/chat/rooms/${roomId}`,
        owner,
        { confirmationName: "統合テスト" },
        "DELETE",
      ),
    );
    assert(deleted.status === 200, "owner should delete the room");
    assert(
      await repository.getRoom(roomId) === null &&
        await repository.getMessage(roomId, postedMessage.id) === null,
      "room deletion should remove the room and its messages",
    );

    const accountDeleted = await sessionHandler(
      mutation(
        "/api/chat/me",
        owner,
        { confirmation: "アカウント削除" },
        "DELETE",
      ),
    );
    assert(
      accountDeleted.status === 200,
      "owner should delete the account after deleting owned rooms",
    );
    assert(
      (await sessionHandler(authenticated("/api/chat/me", owner))).status ===
        401,
      "account deletion should revoke the active session",
    );
  } finally {
    kv.close();
  }
});
