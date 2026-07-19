import { createOtpAuthHandler, OtpAuthService, type OtpMail } from "./auth.ts";
import { ChatRepository } from "./data.ts";
import {
  ChatSessionService,
  createSessionAuthHandler,
  csrfCookieName,
  csrfHeaderName,
  requireChatAuthentication,
  sessionCookieName,
  sessionPolicy,
} from "./session.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }`,
    );
  }
}

interface SessionTestContext {
  repository: ChatRepository;
  service: ChatSessionService;
  handler: (request: Request) => Promise<Response>;
  now(): Date;
  setNow(value: Date): void;
}

async function withSessions(
  run: (context: SessionTestContext) => Promise<void>,
): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  const repository = new ChatRepository(kv);
  let currentTime = new Date(Date.now() + 60 * 60 * 1000);
  let tokenIndex = 0;
  let userIndex = 0;
  const tokenCharacters =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const service = new ChatSessionService({
    repository,
    now: () => new Date(currentTime),
    generateToken: () => tokenCharacters[tokenIndex++].repeat(43),
    generateUserId: () => `user-${++userIndex}`,
  });
  try {
    await run({
      repository,
      service,
      handler: createSessionAuthHandler(service),
      now: () => new Date(currentTime),
      setNow: (value) => currentTime = new Date(value),
    });
  } finally {
    kv.close();
  }
}

function request(
  path: string,
  options: RequestInit = {},
): Request {
  return new Request(`https://chat.example${path}`, options);
}

function getSetCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

function cookieHeader(response: Response): string {
  return getSetCookies(response)
    .map((cookie) => cookie.slice(0, cookie.indexOf(";")))
    .join("; ");
}

function cookieValue(cookies: string, name: string): string {
  const prefix = `${name}=`;
  const part = cookies.split(";").map((value) => value.trim()).find((value) =>
    value.startsWith(prefix)
  );
  if (!part) throw new Error(`Missing cookie ${name}`);
  return part.slice(prefix.length);
}

Deno.test("OTP verification creates a secure 30-day session", async () => {
  await withSessions(async ({ repository, service, now }) => {
    const sent: OtpMail[] = [];
    const otpService = new OtpAuthService({
      repository,
      mailer: {
        sendOtp(mail) {
          sent.push(mail);
          return Promise.resolve();
        },
      },
      authSecret: "test-only-auth-secret-with-at-least-32-bytes",
      now,
      generateCode: () => "123456",
    });
    const authHandler = createOtpAuthHandler(otpService, {
      onVerified: (email, verifiedRequest) =>
        service.completeOtpAuthentication(email, verifiedRequest),
    });
    await authHandler(request("/api/chat/auth/request-otp", {
      method: "POST",
      body: JSON.stringify({ email: "Ada@Example.COM" }),
    }));
    assert(sent.length === 1, "OTP should be delivered");

    const response = await authHandler(request("/api/chat/auth/verify-otp", {
      method: "POST",
      body: JSON.stringify({ email: "ADA@example.com", code: "123456" }),
    }));
    assert(response.status === 200, "OTP verification should create a session");

    const cookies = getSetCookies(response);
    assert(cookies.length === 2, "session and CSRF cookies should be set");
    const sessionCookie = cookies.find((value) =>
      value.startsWith(`${sessionCookieName}=`)
    );
    const csrfCookie = cookies.find((value) =>
      value.startsWith(`${csrfCookieName}=`)
    );
    assert(sessionCookie, "session cookie should be present");
    assert(csrfCookie, "CSRF cookie should be present");
    for (const attribute of ["Path=/", "Secure", "SameSite=Lax"]) {
      assert(
        sessionCookie.includes(attribute),
        `session cookie needs ${attribute}`,
      );
      assert(csrfCookie.includes(attribute), `CSRF cookie needs ${attribute}`);
    }
    assert(
      sessionCookie.includes("HttpOnly"),
      "session cookie must be HttpOnly",
    );
    assert(
      !csrfCookie.includes("HttpOnly"),
      "CSRF cookie must be readable by JS",
    );
    assert(
      sessionCookie.includes("Max-Age=2592000"),
      "session cookie should last 30 days",
    );

    const body = await response.json();
    assert(body.verified === true, "response should report verification");
    assert(body.needsProfile === true, "new users should need a display name");
    assert(
      !JSON.stringify(body).includes("ada@example.com"),
      "email address must not be exposed in the response",
    );
    const rawSessionToken = cookieValue(
      cookieHeaderFromSetCookies(cookies),
      sessionCookieName,
    );
    assert(
      !JSON.stringify(body).includes(rawSessionToken),
      "session token must not be exposed in JSON",
    );
    assert(
      await repository.getSession(rawSessionToken) === null,
      "KV must not store the raw session token as its key",
    );
  });
});

Deno.test("protected me endpoint requires a valid session", async () => {
  await withSessions(async ({ service, handler }) => {
    const unauthorized = await handler(request("/api/chat/me"));
    assert(unauthorized.status === 401, "missing cookie should be rejected");

    const login = await service.completeOtpAuthentication(
      "ada@example.com",
      request("/api/chat/auth/verify-otp", { method: "POST" }),
    );
    const cookies = cookieHeader(login);
    const me = await handler(request("/api/chat/me", {
      headers: { cookie: cookies },
    }));
    assert(me.status === 200, "valid session should access me");
    assertEquals(
      await me.json(),
      {
        user: {
          id: "user-1",
          displayName: null,
          emailNotificationsEnabled: true,
        },
        needsProfile: true,
      },
      "me should return the current public user",
    );

    const middleware = await requireChatAuthentication(
      request("/api/chat/rooms", { headers: { cookie: cookies } }),
      service,
    );
    assert(
      !(middleware instanceof Response) && middleware.user.id === "user-1",
      "authentication middleware should expose the current user",
    );
  });
});

Deno.test("logout requires same-origin CSRF and revokes the session", async () => {
  await withSessions(async ({ service, handler }) => {
    const login = await service.completeOtpAuthentication(
      "ada@example.com",
      request("/api/chat/auth/verify-otp", { method: "POST" }),
    );
    const cookies = cookieHeader(login);
    const csrfToken = cookieValue(cookies, csrfCookieName);

    const missingCsrf = await handler(request("/api/chat/auth/logout", {
      method: "POST",
      headers: { cookie: cookies },
    }));
    assert(
      missingCsrf.status === 403,
      "logout without CSRF should be rejected",
    );

    const mismatchedCsrf = await handler(request("/api/chat/auth/logout", {
      method: "POST",
      headers: {
        cookie: cookies,
        origin: "https://chat.example",
        [csrfHeaderName]: "Z".repeat(43),
      },
    }));
    assert(
      mismatchedCsrf.status === 403,
      "mismatched CSRF token should be rejected",
    );

    const crossOrigin = await handler(request("/api/chat/auth/logout", {
      method: "POST",
      headers: {
        cookie: cookies,
        origin: "https://attacker.example",
        [csrfHeaderName]: csrfToken,
      },
    }));
    assert(
      crossOrigin.status === 403,
      "cross-origin logout should be rejected",
    );

    const logout = await handler(request("/api/chat/auth/logout", {
      method: "POST",
      headers: {
        cookie: cookies,
        origin: "https://chat.example",
        [csrfHeaderName]: csrfToken,
      },
    }));
    assert(logout.status === 200, "valid logout should succeed");
    assert(
      getSetCookies(logout).every((cookie) => cookie.includes("Max-Age=0")),
      "logout should clear both cookies",
    );

    const afterLogout = await handler(request("/api/chat/me", {
      headers: { cookie: cookies },
    }));
    assert(afterLogout.status === 401, "revoked session must not be reusable");
  });
});

Deno.test("expired sessions are rejected and removed", async () => {
  await withSessions(async ({ repository, service, handler, now, setNow }) => {
    const login = await service.completeOtpAuthentication(
      "ada@example.com",
      request("/api/chat/auth/verify-otp", { method: "POST" }),
    );
    const cookies = cookieHeader(login);
    const authenticated = await service.authenticate(request("/api/chat/me", {
      headers: { cookie: cookies },
    }));
    assert(authenticated, "session should initially be valid");

    setNow(new Date(now().getTime() + sessionPolicy.expiresInMilliseconds));
    const expired = await handler(request("/api/chat/me", {
      headers: { cookie: cookies },
    }));
    assert(expired.status === 401, "expired session should be rejected");
    assert(
      await repository.getSession(authenticated.session.id) === null,
      "expired session should be removed from KV",
    );
  });
});

Deno.test("login rotates an existing session to prevent fixation", async () => {
  await withSessions(async ({ service, handler }) => {
    const firstLogin = await service.completeOtpAuthentication(
      "ada@example.com",
      request("/api/chat/auth/verify-otp", { method: "POST" }),
    );
    const firstCookies = cookieHeader(firstLogin);
    const firstToken = cookieValue(firstCookies, sessionCookieName);

    const secondLogin = await service.completeOtpAuthentication(
      "ADA@example.com",
      request("/api/chat/auth/verify-otp", {
        method: "POST",
        headers: { cookie: firstCookies },
      }),
    );
    const secondCookies = cookieHeader(secondLogin);
    const secondToken = cookieValue(secondCookies, sessionCookieName);
    assert(firstToken !== secondToken, "login must rotate the session token");

    const oldSession = await handler(request("/api/chat/me", {
      headers: { cookie: firstCookies },
    }));
    const newSession = await handler(request("/api/chat/me", {
      headers: { cookie: secondCookies },
    }));
    assert(oldSession.status === 401, "old session should be revoked on login");
    assert(newSession.status === 200, "rotated session should be valid");
    assert(
      (await newSession.json()).user.id === "user-1",
      "repeat login should reuse the same user",
    );
  });
});

function cookieHeaderFromSetCookies(cookies: string[]): string {
  return cookies.map((cookie) => cookie.slice(0, cookie.indexOf(";"))).join(
    "; ",
  );
}
