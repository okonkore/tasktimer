import {
  createOtpAuthHandler,
  generateOtpCode,
  OtpAuthService,
  type OtpMail,
  type OtpMailer,
  otpPolicy,
  ResendOtpMailer,
} from "./auth.ts";
import { ChatRepository } from "./data.ts";

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

class FakeMailer implements OtpMailer {
  messages: OtpMail[] = [];
  shouldFail = false;

  sendOtp(mail: OtpMail): Promise<void> {
    if (this.shouldFail) return Promise.reject(new Error("delivery failed"));
    this.messages.push(mail);
    return Promise.resolve();
  }
}

interface TestContext {
  kv: Deno.Kv;
  repository: ChatRepository;
  mailer: FakeMailer;
  handler: (request: Request) => Promise<Response>;
  setNow(value: Date): void;
}

async function withAuth(
  run: (context: TestContext) => Promise<void>,
  codes = ["123456"],
): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  const repository = new ChatRepository(kv);
  const mailer = new FakeMailer();
  let currentTime = new Date(Date.now() + 60 * 60 * 1000);
  let codeIndex = 0;
  const service = new OtpAuthService({
    repository,
    mailer,
    authSecret: "test-only-auth-secret-with-at-least-32-bytes",
    now: () => new Date(currentTime),
    generateCode: () => codes[Math.min(codeIndex++, codes.length - 1)],
  });
  try {
    await run({
      kv,
      repository,
      mailer,
      handler: createOtpAuthHandler(service),
      setNow: (value) => currentTime = new Date(value),
    });
  } finally {
    kv.close();
  }
}

function post(
  handler: (request: Request) => Promise<Response>,
  path: string,
  body: unknown,
): Promise<Response> {
  return handler(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

Deno.test("OTP codes are six cryptographically generated digits", () => {
  for (let index = 0; index < 100; index += 1) {
    assert(/^\d{6}$/.test(generateOtpCode()), "OTP should contain six digits");
  }
});

Deno.test("request and verify OTP without storing plaintext", async () => {
  await withAuth(async ({ repository, mailer, handler }) => {
    const requestResponse = await post(
      handler,
      "/api/chat/auth/request-otp",
      { email: " Ada@Example.COM " },
    );
    assert(requestResponse.status === 202, "OTP request should be accepted");
    assertEquals(
      mailer.messages,
      [{ to: "ada@example.com", code: "123456", expiresInMinutes: 10 }],
      "mailer should receive the normalized address and generated code",
    );

    const stored = await repository.getOtpChallenge("ada@example.com");
    assert(stored !== null, "challenge should be stored");
    assert(stored.codeHash !== "123456", "stored value must be hashed");
    assert(
      !JSON.stringify(stored).includes("123456"),
      "stored challenge must not contain plaintext OTP",
    );
    assert(
      new Date(stored.expiresAt).getTime() -
          new Date(stored.createdAt).getTime() ===
        otpPolicy.expiresInMilliseconds,
      "challenge should expire after ten minutes",
    );

    const verifyResponse = await post(
      handler,
      "/api/chat/auth/verify-otp",
      { email: "ADA@example.com", code: "123456" },
    );
    assert(verifyResponse.status === 200, "correct OTP should verify");
    assert(
      (await verifyResponse.json()).verified === true,
      "verification response should report success",
    );
    assert(
      await repository.getOtpChallenge("ada@example.com") === null,
      "successful OTP must be consumed",
    );

    const replayResponse = await post(
      handler,
      "/api/chat/auth/verify-otp",
      { email: "ada@example.com", code: "123456" },
    );
    assert(replayResponse.status === 401, "consumed OTP must not be reusable");
  });
});

Deno.test("OTP resend cooldown replaces and invalidates the old code", async () => {
  await withAuth(async ({ mailer, handler, setNow }) => {
    await post(handler, "/api/chat/auth/request-otp", {
      email: "ada@example.com",
    });
    const cooldownResponse = await post(
      handler,
      "/api/chat/auth/request-otp",
      { email: "ada@example.com" },
    );
    assert(
      cooldownResponse.status === 429,
      "immediate resend should be blocked",
    );
    assert(
      cooldownResponse.headers.get("retry-after") === "60",
      "cooldown should advertise 60 seconds",
    );
    assert(
      mailer.messages.length === 1,
      "cooldown must not send another email",
    );

    setNow(new Date(Date.now() + 60 * 60 * 1000 + 61_000));
    const resendResponse = await post(
      handler,
      "/api/chat/auth/request-otp",
      { email: "ada@example.com" },
    );
    assert(resendResponse.status === 202, "resend should work after cooldown");
    assertEquals(mailer.messages.length, 2, "resend should send a new email");

    const oldCodeResponse = await post(
      handler,
      "/api/chat/auth/verify-otp",
      { email: "ada@example.com", code: "111111" },
    );
    assert(oldCodeResponse.status === 401, "old OTP should be invalidated");
    const newCodeResponse = await post(
      handler,
      "/api/chat/auth/verify-otp",
      { email: "ada@example.com", code: "222222" },
    );
    assert(newCodeResponse.status === 200, "new OTP should verify");
  }, ["111111", "222222"]);
});

Deno.test("OTP expiry and five-attempt limit are enforced", async () => {
  await withAuth(async ({ repository, handler }) => {
    await post(handler, "/api/chat/auth/request-otp", {
      email: "attempts@example.com",
    });
    for (let attempt = 0; attempt < otpPolicy.maxFailedAttempts; attempt += 1) {
      const response = await post(handler, "/api/chat/auth/verify-otp", {
        email: "attempts@example.com",
        code: "000000",
      });
      assert(response.status === 401, "incorrect OTP should be rejected");
    }
    const challenge = await repository.getOtpChallenge("attempts@example.com");
    assert(
      challenge?.failedAttempts === otpPolicy.maxFailedAttempts,
      "failed attempts should be persisted",
    );
    const lockedResponse = await post(handler, "/api/chat/auth/verify-otp", {
      email: "attempts@example.com",
      code: "123456",
    });
    assert(
      lockedResponse.status === 401,
      "correct OTP after five failures must fail",
    );
  });

  await withAuth(async ({ handler, setNow }) => {
    const base = new Date(Date.now() + 60 * 60 * 1000);
    setNow(base);
    await post(handler, "/api/chat/auth/request-otp", {
      email: "expired@example.com",
    });
    setNow(new Date(base.getTime() + otpPolicy.expiresInMilliseconds));
    const response = await post(handler, "/api/chat/auth/verify-otp", {
      email: "expired@example.com",
      code: "123456",
    });
    assert(response.status === 401, "expired OTP should be rejected");
  });
});

Deno.test("verification errors do not reveal whether a challenge exists", async () => {
  await withAuth(async ({ handler }) => {
    const missing = await post(handler, "/api/chat/auth/verify-otp", {
      email: "missing@example.com",
      code: "000000",
    });
    await post(handler, "/api/chat/auth/request-otp", {
      email: "existing@example.com",
    });
    const incorrect = await post(handler, "/api/chat/auth/verify-otp", {
      email: "existing@example.com",
      code: "000000",
    });
    assert(missing.status === incorrect.status, "statuses should match");
    assertEquals(
      await missing.json(),
      await incorrect.json(),
      "error bodies should match",
    );
  });
});

Deno.test("mail delivery failure removes the unusable challenge", async () => {
  await withAuth(async ({ repository, mailer, handler }) => {
    mailer.shouldFail = true;
    const response = await post(handler, "/api/chat/auth/request-otp", {
      email: "failed@example.com",
    });
    assert(
      response.status === 503,
      "delivery failure should be reported safely",
    );
    assert(
      await repository.getOtpChallenge("failed@example.com") === null,
      "unsent OTP challenge should be removed",
    );
  });
});

Deno.test("Resend adapter sends the OTP and rejects API failures", async () => {
  const capturedRequests: Request[] = [];
  const mailer = new ResendOtpMailer({
    apiKey: "resend-test-key",
    from: "Paradise Timer <login@example.com>",
    fetcher: (input, init) => {
      capturedRequests.push(new Request(input, init));
      return Promise.resolve(new Response(null, { status: 200 }));
    },
  });
  await mailer.sendOtp({
    to: "ada@example.com",
    code: "123456",
    expiresInMinutes: 10,
  });
  const capturedRequest = capturedRequests[0];
  assert(capturedRequest !== undefined, "Resend request should be sent");
  assert(
    capturedRequest.url === "https://api.resend.com/emails",
    "Resend endpoint should be used",
  );
  assert(
    capturedRequest.headers.get("authorization") === "Bearer resend-test-key",
    "Resend API key should be sent as bearer authorization",
  );
  const payload = await capturedRequest.json();
  assertEquals(
    payload,
    {
      from: "Paradise Timer <login@example.com>",
      to: ["ada@example.com"],
      subject: "Paradise Timer ログインコード",
      text: "ログインコードは 123456 です。\n\n" +
        "このコードは10分で期限切れになります。" +
        "心当たりがない場合は、このメールを無視してください。",
    },
    "Resend payload should contain the login code",
  );

  const failingMailer = new ResendOtpMailer({
    apiKey: "resend-test-key",
    from: "login@example.com",
    fetcher: () => Promise.resolve(new Response(null, { status: 500 })),
  });
  let failed = false;
  try {
    await failingMailer.sendOtp({
      to: "ada@example.com",
      code: "123456",
      expiresInMinutes: 10,
    });
  } catch {
    failed = true;
  }
  assert(failed, "Resend non-success response should reject");
});
