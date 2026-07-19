import {
  ChatRepository,
  normalizeEmail,
  type Session,
  type User,
} from "./data.ts";

export const sessionPolicy = Object.freeze({
  expiresInMilliseconds: 30 * 24 * 60 * 60 * 1000,
  tokenBytes: 32,
});

export const sessionCookieName = "__Host-tasktimer_chat_session";
export const csrfCookieName = "__Host-tasktimer_chat_csrf";
export const csrfHeaderName = "x-csrf-token";

const maxProfileRequestBytes = 8 * 1024;

type Clock = () => Date;
type TokenGenerator = () => string;
type UserIdGenerator = () => string;

export interface SessionServiceOptions {
  repository: ChatRepository;
  now?: Clock;
  generateToken?: TokenGenerator;
  generateUserId?: UserIdGenerator;
}

export interface AuthenticatedChatRequest {
  user: User;
  session: Session;
  sessionVersionstamp: string;
}

export interface CurrentUser {
  id: string;
  displayName: string | null;
  emailNotificationsEnabled: boolean;
}

export class ChatSessionService {
  readonly #repository: ChatRepository;
  readonly #now: Clock;
  readonly #generateToken: TokenGenerator;
  readonly #generateUserId: UserIdGenerator;

  constructor(options: SessionServiceOptions) {
    this.#repository = options.repository;
    this.#now = options.now ?? (() => new Date());
    this.#generateToken = options.generateToken ?? generateSecureToken;
    this.#generateUserId = options.generateUserId ??
      (() => crypto.randomUUID());
  }

  async completeOtpAuthentication(
    email: string,
    request: Request,
  ): Promise<Response> {
    try {
      const oldToken = getCookie(
        request.headers.get("cookie"),
        sessionCookieName,
      );
      if (oldToken && isSecureToken(oldToken)) {
        await this.#repository.deleteSession(
          await hashToken("session", oldToken),
        );
      }

      const user = await this.#getOrCreateUser(email);
      if (user.deletedAt) {
        return sessionJson({ error: "Account is unavailable" }, 403);
      }

      const now = this.#now();
      const expiresAt = new Date(
        now.getTime() + sessionPolicy.expiresInMilliseconds,
      );
      let sessionToken = "";
      let csrfToken = "";
      let created = false;

      for (let attempt = 0; attempt < 4; attempt += 1) {
        sessionToken = this.#generateToken();
        csrfToken = this.#generateToken();
        if (
          !isSecureToken(sessionToken) || !isSecureToken(csrfToken) ||
          sessionToken === csrfToken || sessionToken === oldToken
        ) {
          continue;
        }
        const session: Session = {
          id: await hashToken("session", sessionToken),
          userId: user.id,
          csrfTokenHash: await hashToken("csrf", csrfToken),
          createdAt: now.toISOString(),
          expiresAt: expiresAt.toISOString(),
        };
        if (await this.#repository.createSession(session)) {
          created = true;
          break;
        }
      }
      if (!created) {
        return sessionJson({ error: "Could not create a session" }, 503);
      }

      const response = sessionJson({
        ok: true,
        verified: true,
        user: currentUser(user),
        needsProfile: user.displayName === null,
      });
      appendSessionCookies(
        response.headers,
        sessionToken,
        csrfToken,
        expiresAt,
      );
      return response;
    } catch {
      return sessionJson({ error: "Could not create a session" }, 503);
    }
  }

  async authenticate(
    request: Request,
  ): Promise<AuthenticatedChatRequest | null> {
    const token = getCookie(request.headers.get("cookie"), sessionCookieName);
    if (!token || !isSecureToken(token)) return null;

    const sessionId = await hashToken("session", token);
    const entry = await this.#repository.getSessionEntry(sessionId);
    const session = entry.value;
    if (!session || !entry.versionstamp) return null;

    const expiresAt = new Date(session.expiresAt).getTime();
    if (!Number.isFinite(expiresAt) || this.#now().getTime() >= expiresAt) {
      await this.#repository.deleteSession(sessionId, entry.versionstamp);
      return null;
    }

    const user = await this.#repository.getUser(session.userId);
    if (!user || user.deletedAt) {
      await this.#repository.deleteSession(sessionId, entry.versionstamp);
      return null;
    }
    return { user, session, sessionVersionstamp: entry.versionstamp };
  }

  async verifyCsrf(
    request: Request,
    authenticated: AuthenticatedChatRequest,
  ): Promise<boolean> {
    const origin = request.headers.get("origin");
    if (!origin || !sameOrigin(origin, new URL(request.url).origin)) {
      return false;
    }

    const cookieToken = getCookie(
      request.headers.get("cookie"),
      csrfCookieName,
    );
    const headerToken = request.headers.get(csrfHeaderName);
    if (
      !cookieToken || !headerToken || !isSecureToken(cookieToken) ||
      !constantTimeEqual(cookieToken, headerToken)
    ) {
      return false;
    }
    return constantTimeEqual(
      await hashToken("csrf", cookieToken),
      authenticated.session.csrfTokenHash,
    );
  }

  async revoke(authenticated: AuthenticatedChatRequest): Promise<void> {
    await this.#repository.deleteSession(
      authenticated.session.id,
      authenticated.sessionVersionstamp,
    );
  }

  async updateDisplayName(
    authenticated: AuthenticatedChatRequest,
    displayName: string,
  ): Promise<User | null> {
    return await this.#repository.updateUserDisplayName(
      authenticated.user.id,
      displayName,
      this.#now().toISOString(),
    );
  }

  async #getOrCreateUser(email: string): Promise<User> {
    const normalizedEmail = normalizeEmail(email);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const existing = await this.#repository.getUserByEmail(normalizedEmail);
      if (existing) return existing;

      const now = this.#now().toISOString();
      const user: User = {
        id: this.#generateUserId(),
        email: normalizedEmail,
        displayName: null,
        emailNotificationsEnabled: true,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      if (await this.#repository.createUser(user)) return user;
    }
    const existing = await this.#repository.getUserByEmail(normalizedEmail);
    if (existing) return existing;
    throw new Error("Could not create user");
  }
}

export function createSessionAuthHandler(
  service: ChatSessionService,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === "/api/chat/me") {
      if (request.method === "GET") {
        const authenticated = await requireChatAuthentication(request, service);
        if (authenticated instanceof Response) return authenticated;
        return sessionJson({
          user: currentUser(authenticated.user),
          needsProfile: authenticated.user.displayName === null,
        });
      }

      if (request.method === "PATCH") {
        const authenticated = await requireChatMutation(request, service);
        if (authenticated instanceof Response) return authenticated;
        const body = await readProfileJson(request);
        if (body instanceof Response) return body;
        const displayName = displayNameFrom(body);
        if (!displayName) {
          return sessionJson(
            { error: "Display name must be between 1 and 30 characters" },
            400,
          );
        }

        const user = await service.updateDisplayName(
          authenticated,
          displayName,
        );
        if (!user) {
          return sessionJson({ error: "Could not update profile" }, 503);
        }
        return sessionJson({ user: currentUser(user), needsProfile: false });
      }

      return sessionJson({ error: "Method not allowed" }, 405, {
        Allow: "GET, PATCH",
      });
    }

    if (path === "/api/chat/auth/logout") {
      if (request.method !== "POST") {
        return sessionJson({ error: "Method not allowed" }, 405, {
          Allow: "POST",
        });
      }
      const authenticated = await requireChatMutation(request, service);
      if (authenticated instanceof Response) return authenticated;
      await service.revoke(authenticated);
      const response = sessionJson({ ok: true });
      appendClearedSessionCookies(response.headers);
      return response;
    }

    return sessionJson({ error: "Not found" }, 404);
  };
}

export async function requireChatAuthentication(
  request: Request,
  service: ChatSessionService,
): Promise<AuthenticatedChatRequest | Response> {
  const authenticated = await service.authenticate(request);
  if (authenticated) return authenticated;
  const response = sessionJson({ error: "Authentication required" }, 401);
  appendClearedSessionCookies(response.headers);
  return response;
}

export async function requireChatMutation(
  request: Request,
  service: ChatSessionService,
): Promise<AuthenticatedChatRequest | Response> {
  const authenticated = await requireChatAuthentication(request, service);
  if (authenticated instanceof Response) return authenticated;
  if (!await service.verifyCsrf(request, authenticated)) {
    return sessionJson({ error: "CSRF validation failed" }, 403);
  }
  return authenticated;
}

export function generateSecureToken(): string {
  const bytes = crypto.getRandomValues(
    new Uint8Array(sessionPolicy.tokenBytes),
  );
  return encodeBase64Url(bytes);
}

function currentUser(user: User): CurrentUser {
  return {
    id: user.id,
    displayName: user.displayName,
    emailNotificationsEnabled: user.emailNotificationsEnabled,
  };
}

function displayNameFrom(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const displayName = (value as Record<string, unknown>).displayName;
  if (typeof displayName !== "string") return null;
  const normalized = displayName.trim();
  return normalized.length >= 1 && normalized.length <= 30 ? normalized : null;
}

async function readProfileJson(request: Request): Promise<unknown | Response> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > maxProfileRequestBytes) {
    return sessionJson({ error: "Request body is too large" }, 413);
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    return sessionJson({ error: "Could not read request body" }, 400);
  }
  if (new TextEncoder().encode(text).byteLength > maxProfileRequestBytes) {
    return sessionJson({ error: "Request body is too large" }, 413);
  }
  try {
    return JSON.parse(text);
  } catch {
    return sessionJson({ error: "Invalid JSON" }, 400);
  }
}

function isSecureToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

async function hashToken(kind: "session" | "csrf", token: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`chat-${kind}\0${token}`),
  );
  return encodeBase64Url(new Uint8Array(digest));
}

function sameOrigin(value: string, expected: string): boolean {
  try {
    return new URL(value).origin === expected;
  } catch {
    return false;
  }
}

function getCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

function appendSessionCookies(
  headers: Headers,
  sessionToken: string,
  csrfToken: string,
  expiresAt: Date,
): void {
  const maxAge = Math.floor(sessionPolicy.expiresInMilliseconds / 1000);
  const shared =
    `Path=/; Max-Age=${maxAge}; Expires=${expiresAt.toUTCString()}; Secure; SameSite=Lax`;
  headers.append(
    "set-cookie",
    `${sessionCookieName}=${sessionToken}; ${shared}; HttpOnly`,
  );
  headers.append("set-cookie", `${csrfCookieName}=${csrfToken}; ${shared}`);
}

function appendClearedSessionCookies(headers: Headers): void {
  const expired =
    "Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Lax";
  headers.append("set-cookie", `${sessionCookieName}=; ${expired}; HttpOnly`);
  headers.append("set-cookie", `${csrfCookieName}=; ${expired}`);
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

function sessionJson(
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
