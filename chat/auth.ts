import {
  chatLimits,
  ChatRepository,
  normalizeEmail,
  type OtpChallenge,
  type PasswordCredential,
  type User,
} from "./data.ts";

export const otpPolicy = Object.freeze({
  codeDigits: 6,
  expiresInMilliseconds: 10 * 60 * 1000,
  resendCooldownMilliseconds: 60 * 1000,
  maxFailedAttempts: 5,
  requestWindowMilliseconds: 60 * 60 * 1000,
});

const maxAuthRequestBytes = 8 * 1024;
const genericVerificationError = "The code is invalid or has expired";
const genericPasswordLoginError =
  "ユーザー名またはパスワードが正しくありません";

export const passwordPolicy = Object.freeze({
  minLength: 12,
  maxLength: 128,
  iterations: 210_000,
  loginWindowMilliseconds: 15 * 60 * 1000,
  maxLoginAttemptsPerIp: 30,
  maxLoginAttemptsPerUsername: 10,
  registrationWindowMilliseconds: 15 * 60 * 1000,
  maxRegistrationsPerIp: 10,
});
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}
export function isValidUsername(username: unknown): username is string {
  return typeof username === "string" &&
    /^[a-zA-Z0-9_-]{3,32}$/.test(username.trim());
}
export function isValidPassword(password: unknown): password is string {
  return typeof password === "string" &&
    password.length >= passwordPolicy.minLength &&
    password.length <= passwordPolicy.maxLength;
}

export class PasswordAuthService {
  readonly #repository: ChatRepository;
  readonly #now: Clock;
  constructor(options: { repository: ChatRepository; now?: Clock }) {
    this.#repository = options.repository;
    this.#now = options.now ?? (() => new Date());
  }
  async register(
    username: string,
    password: string,
    clientIp: string,
  ): Promise<User | "rate-limited" | null> {
    const name = normalizeUsername(username);
    if (!isValidUsername(name) || !isValidPassword(password)) return null;
    const rateLimit = await this.#repository.consumeRateLimit(
      "password-register-ip",
      clientIp,
      this.#now(),
      passwordPolicy.registrationWindowMilliseconds,
      passwordPolicy.maxRegistrationsPerIp,
    );
    if (!rateLimit.allowed) return "rate-limited";
    const now = this.#now().toISOString();
    const id = crypto.randomUUID();
    const salt = encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    const credential: PasswordCredential = {
      userId: id,
      salt,
      hash: await hashPassword(password, salt, passwordPolicy.iterations),
      iterations: passwordPolicy.iterations,
      createdAt: now,
    };
    const user: User = {
      id,
      email: `${name}@password.local`,
      username: name,
      displayName: null,
      emailNotificationsEnabled: false,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    return await this.#repository.createPasswordUser(user, credential)
      ? user
      : null;
  }
  async authenticate(
    username: string,
    password: string,
    clientIp: string,
  ): Promise<User | null> {
    const name = normalizeUsername(username);
    const now = this.#now();
    const [ip, account] = await Promise.all([
      this.#repository.consumeRateLimit(
        "password-ip",
        clientIp,
        now,
        passwordPolicy.loginWindowMilliseconds,
        passwordPolicy.maxLoginAttemptsPerIp,
      ),
      this.#repository.consumeRateLimit(
        "password-username",
        name,
        now,
        passwordPolicy.loginWindowMilliseconds,
        passwordPolicy.maxLoginAttemptsPerUsername,
      ),
    ]);
    if (
      !ip.allowed || !account.allowed || !isValidUsername(name) ||
      !isValidPassword(password)
    ) return null;
    const user = await this.#repository.getUserByUsername(name);
    if (!user || user.deletedAt) return null;
    const credential = await this.#repository.getPasswordCredential(user.id);
    if (!credential) return null;
    return constantTimeEqual(
        await hashPassword(password, credential.salt, credential.iterations),
        credential.hash,
      )
      ? user
      : null;
  }
}

export function createPasswordAuthHandler(
  service: PasswordAuthService,
  options: {
    onAuthenticated: (user: User, request: Request) => Promise<Response>;
    getClientIp?: (request: Request) => string;
  },
): (request: Request) => Promise<Response> {
  return async (request) => {
    const path = new URL(request.url).pathname;
    const register = path === "/api/chat/auth/password/register";
    const login = path === "/api/chat/auth/password/login";
    if (!register && !login) return authJson({ error: "Not found" }, 404);
    if (request.method !== "POST") {
      return authJson({ error: "Method not allowed" }, 405, { Allow: "POST" });
    }
    if (
      request.headers.get("content-type")?.split(";")[0].trim()
        .toLowerCase() !== "application/json"
    ) return authJson({ error: "Content-Type must be application/json" }, 415);
    const body = await readAuthJson(request);
    if (
      body instanceof Response || !body || typeof body !== "object" ||
      Array.isArray(body)
    ) {
      return body instanceof Response
        ? body
        : authJson({ error: "Invalid authentication request" }, 400);
    }
    const candidate = body as Record<string, unknown>;
    if (
      Object.keys(candidate).some((key) =>
        key !== "username" && key !== "password"
      )
    ) return authJson({ error: "Invalid authentication request" }, 400);
    if (
      !isValidUsername(candidate.username) ||
      !isValidPassword(candidate.password)
    ) {
      return authJson({
        error: register
          ? "ユーザー名は3〜32文字、パスワードは12〜128文字で入力してください"
          : genericPasswordLoginError,
      }, register ? 400 : 401);
    }
    if (register) {
      const user = await service.register(
        candidate.username,
        candidate.password,
        options.getClientIp?.(request) ?? "unavailable",
      );
      if (user === "rate-limited") {
        return authJson(
          { error: "登録試行が多すぎます。しばらくしてからお試しください。" },
          429,
          {
            "retry-after": String(
              Math.ceil(passwordPolicy.registrationWindowMilliseconds / 1000),
            ),
          },
        );
      }
      if (!user) {
        return authJson({ error: "このユーザー名は利用できません" }, 409);
      }
      return await options.onAuthenticated(user, request);
    }
    const user = await service.authenticate(
      candidate.username,
      candidate.password,
      options.getClientIp?.(request) ?? "unavailable",
    );
    return user
      ? await options.onAuthenticated(user, request)
      : authJson({ error: genericPasswordLoginError }, 401);
  };
}

export interface OtpMail {
  to: string;
  code: string;
  expiresInMinutes: number;
}

export interface OtpMailer {
  sendOtp(mail: OtpMail): Promise<void>;
}

export interface ResendOtpMailerOptions {
  apiKey: string;
  from: string;
  fetcher?: typeof fetch;
}

export class ResendOtpMailer implements OtpMailer {
  readonly #apiKey: string;
  readonly #from: string;
  readonly #fetcher: typeof fetch;

  constructor(options: ResendOtpMailerOptions) {
    if (!options.apiKey || !options.from) {
      throw new Error("Resend configuration is incomplete");
    }
    this.#apiKey = options.apiKey;
    this.#from = options.from;
    this.#fetcher = options.fetcher ?? fetch;
  }

  async sendOtp(mail: OtpMail): Promise<void> {
    const response = await this.#fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: this.#from,
        to: [mail.to],
        subject: "Paradise Timer ログインコード",
        text: `ログインコードは ${mail.code} です。\n\n` +
          `このコードは${mail.expiresInMinutes}分で期限切れになります。` +
          "心当たりがない場合は、このメールを無視してください。",
      }),
    });
    if (!response.ok) {
      throw new Error(`Resend request failed with status ${response.status}`);
    }
  }
}

type Clock = () => Date;
type CodeGenerator = () => string;

export interface OtpAuthServiceOptions {
  repository: ChatRepository;
  mailer: OtpMailer;
  authSecret: string;
  now?: Clock;
  generateCode?: CodeGenerator;
}

export type RequestOtpResult =
  | { status: "sent" }
  | { status: "cooldown"; retryAfterSeconds: number; retryAt: string }
  | {
    status: "rate-limited";
    reason: "email" | "ip";
    retryAt: string;
  }
  | { status: "delivery-failed" }
  | { status: "temporary-error" };

export type VerifyOtpResult =
  | { status: "verified"; email: string }
  | { status: "invalid" }
  | { status: "temporary-error" };

export class OtpAuthService {
  readonly #repository: ChatRepository;
  readonly #mailer: OtpMailer;
  readonly #authSecret: string;
  readonly #now: Clock;
  readonly #generateCode: CodeGenerator;

  constructor(options: OtpAuthServiceOptions) {
    if (new TextEncoder().encode(options.authSecret).byteLength < 32) {
      throw new Error("AUTH_SECRET must contain at least 32 bytes");
    }
    this.#repository = options.repository;
    this.#mailer = options.mailer;
    this.#authSecret = options.authSecret;
    this.#now = options.now ?? (() => new Date());
    this.#generateCode = options.generateCode ?? generateOtpCode;
  }

  async requestOtp(
    email: string,
    clientIp = "unavailable",
  ): Promise<RequestOtpResult> {
    const normalizedEmail = normalizeEmail(email);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const entry = await this.#repository.getOtpChallengeEntry(
        normalizedEmail,
      );
      const now = this.#now();
      const retryAfterSeconds = entry.value
        ? resendRetryAfterSeconds(entry.value, now)
        : 0;
      if (retryAfterSeconds > 0) {
        return {
          status: "cooldown",
          retryAfterSeconds,
          retryAt: new Date(
            now.getTime() + retryAfterSeconds * 1000,
          ).toISOString(),
        };
      }

      const ipLimit = await this.#repository.consumeRateLimit(
        "otp-ip",
        await hashOtp(this.#authSecret, "rate-ip", clientIp),
        now,
        otpPolicy.requestWindowMilliseconds,
        chatLimits.maxOtpRequestsPerIpHour,
      );
      if (!ipLimit.allowed) {
        return {
          status: "rate-limited",
          reason: "ip",
          retryAt: ipLimit.retryAt,
        };
      }
      const emailLimit = await this.#repository.consumeRateLimit(
        "otp-email",
        await hashOtp(this.#authSecret, "rate-email", normalizedEmail),
        now,
        otpPolicy.requestWindowMilliseconds,
        chatLimits.maxOtpRequestsPerEmailHour,
      );
      if (!emailLimit.allowed) {
        return {
          status: "rate-limited",
          reason: "email",
          retryAt: emailLimit.retryAt,
        };
      }

      const code = this.#generateCode();
      if (!/^\d{6}$/.test(code)) {
        throw new Error("OTP generator must return exactly 6 digits");
      }
      const nowIso = now.toISOString();
      const challenge: OtpChallenge = {
        email: normalizedEmail,
        codeHash: await hashOtp(this.#authSecret, normalizedEmail, code),
        failedAttempts: 0,
        createdAt: nowIso,
        expiresAt: new Date(
          now.getTime() + otpPolicy.expiresInMilliseconds,
        ).toISOString(),
        lastSentAt: nowIso,
      };
      const versionstamp = await this.#repository.replaceOtpChallenge(
        challenge,
        entry.versionstamp,
      );
      if (!versionstamp) continue;

      try {
        await this.#mailer.sendOtp({
          to: normalizedEmail,
          code,
          expiresInMinutes: otpPolicy.expiresInMilliseconds / 60_000,
        });
      } catch {
        await this.#repository.deleteOtpChallenge(
          normalizedEmail,
          versionstamp,
        );
        return { status: "delivery-failed" };
      }
      return { status: "sent" };
    }

    return { status: "temporary-error" };
  }

  async verifyOtp(email: string, code: string): Promise<VerifyOtpResult> {
    const normalizedEmail = normalizeEmail(email);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const entry = await this.#repository.getOtpChallengeEntry(
        normalizedEmail,
      );
      const challenge = entry.value;
      if (!challenge || !entry.versionstamp) return { status: "invalid" };

      const now = this.#now();
      if (
        !Number.isFinite(new Date(challenge.expiresAt).getTime()) ||
        now.getTime() >= new Date(challenge.expiresAt).getTime() ||
        challenge.failedAttempts >= otpPolicy.maxFailedAttempts
      ) {
        await this.#repository.deleteOtpChallenge(
          normalizedEmail,
          entry.versionstamp,
        );
        return { status: "invalid" };
      }

      const candidateHash = await hashOtp(
        this.#authSecret,
        normalizedEmail,
        code,
      );
      if (constantTimeEqual(candidateHash, challenge.codeHash)) {
        const consumed = await this.#repository.deleteOtpChallenge(
          normalizedEmail,
          entry.versionstamp,
        );
        if (consumed) return { status: "verified", email: normalizedEmail };
        continue;
      }

      const updatedVersionstamp = await this.#repository.replaceOtpChallenge(
        { ...challenge, failedAttempts: challenge.failedAttempts + 1 },
        entry.versionstamp,
      );
      if (updatedVersionstamp) return { status: "invalid" };
    }

    return { status: "temporary-error" };
  }
}

export function generateOtpCode(): string {
  const range = 1_000_000;
  const largestAcceptable = Math.floor(0x1_0000_0000 / range) * range;
  const random = new Uint32Array(1);
  do crypto.getRandomValues(random); while (random[0] >= largestAcceptable);
  return (random[0] % range).toString().padStart(otpPolicy.codeDigits, "0");
}

export function isValidEmail(email: unknown): email is string {
  if (typeof email !== "string") return false;
  const normalized = normalizeEmail(email);
  return !normalized.endsWith("@password.local") && normalized.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
}

export function createOtpAuthHandler(
  service: OtpAuthService,
  options: OtpAuthHandlerOptions = {},
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    const isRequestRoute = path === "/api/chat/auth/request-otp";
    const isVerifyRoute = path === "/api/chat/auth/verify-otp";
    if (!isRequestRoute && !isVerifyRoute) {
      return authJson({ error: "Not found" }, 404);
    }
    if (request.method !== "POST") {
      return authJson({ error: "Method not allowed" }, 405, { Allow: "POST" });
    }
    if (
      request.headers.get("content-type")?.split(";")[0].trim()
        .toLowerCase() !==
        "application/json"
    ) {
      return authJson({ error: "Content-Type must be application/json" }, 415);
    }

    const body = await readAuthJson(request);
    if (body instanceof Response) return body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return authJson({ error: "Invalid authentication request" }, 400);
    }
    const allowedKeys = isRequestRoute ? ["email"] : ["email", "code"];
    if (
      Object.keys(body as Record<string, unknown>).some((key) =>
        !allowedKeys.includes(key)
      )
    ) {
      return authJson({ error: "Invalid authentication request" }, 400);
    }
    const email = body && typeof body === "object"
      ? (body as Record<string, unknown>).email
      : undefined;
    if (!isValidEmail(email)) {
      return authJson({ error: "A valid email address is required" }, 400);
    }

    if (isRequestRoute) {
      const result = await service.requestOtp(
        email,
        options.getClientIp?.(request) ?? "unavailable",
      );
      if (result.status === "sent") {
        return authJson({
          ok: true,
          message: "If the address can receive email, a code has been sent",
        }, 202);
      }
      if (result.status === "cooldown") {
        return authJson(
          {
            error: "Please wait before requesting another code",
            retryAfterSeconds: result.retryAfterSeconds,
            retryAt: result.retryAt,
          },
          429,
          { "retry-after": String(result.retryAfterSeconds) },
        );
      }
      if (result.status === "rate-limited") {
        return rateLimitResponse(
          result.reason === "email"
            ? "Too many login codes were requested for this address"
            : "Too many login codes were requested from this network",
          result.retryAt,
        );
      }
      // Delivery failures deliberately have the same response as successful
      // requests so the endpoint cannot be used to enumerate deliverable or
      // registered addresses.
      if (result.status === "delivery-failed") {
        return authJson({
          ok: true,
          message: "If the address can receive email, a code has been sent",
        }, 202);
      }
      return authJson(
        { error: "Authentication is temporarily unavailable" },
        503,
      );
    }

    const code = (body as Record<string, unknown>).code;
    if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
      return authJson({ error: genericVerificationError }, 401);
    }
    const result = await service.verifyOtp(email, code);
    if (result.status === "verified") {
      if (options.onVerified) {
        return await options.onVerified(result.email, request);
      }
      return authJson({ ok: true, verified: true });
    }
    if (result.status === "temporary-error") {
      return authJson(
        { error: "Authentication is temporarily unavailable" },
        503,
      );
    }
    return authJson({ error: genericVerificationError }, 401);
  };
}

export interface OtpAuthHandlerOptions {
  onVerified?: (email: string, request: Request) => Promise<Response>;
  getClientIp?: (request: Request) => string;
}

function rateLimitResponse(error: string, retryAt: string): Response {
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((new Date(retryAt).getTime() - Date.now()) / 1000),
  );
  return authJson(
    { error, retryAt },
    429,
    { "retry-after": String(retryAfterSeconds) },
  );
}

function resendRetryAfterSeconds(challenge: OtpChallenge, now: Date): number {
  const sentAt = new Date(challenge.lastSentAt).getTime();
  if (!Number.isFinite(sentAt)) return 0;
  const remaining = otpPolicy.resendCooldownMilliseconds -
    Math.max(0, now.getTime() - sentAt);
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

async function hashOtp(
  secret: string,
  email: string,
  code: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`chat-otp\0${email}\0${code}`),
  );
  return encodeBase64Url(new Uint8Array(signature));
}

async function hashPassword(
  password: string,
  salt: string,
  iterations: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new TextEncoder().encode(salt),
      iterations,
    },
    key,
    256,
  );
  return encodeBase64Url(new Uint8Array(bits));
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

async function readAuthJson(request: Request): Promise<unknown | Response> {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > maxAuthRequestBytes) {
    return authJson({ error: "Request body is too large" }, 413);
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return authJson({ error: "Could not read request body" }, 400);
  }
  if (new TextEncoder().encode(text).byteLength > maxAuthRequestBytes) {
    return authJson({ error: "Request body is too large" }, 413);
  }
  try {
    return JSON.parse(text);
  } catch {
    return authJson({ error: "Invalid JSON" }, 400);
  }
}

function authJson(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}
