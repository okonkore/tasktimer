import {
  createOtpAuthHandler,
  OtpAuthService,
  ResendOtpMailer,
} from "./chat/auth.ts";
import { ChatRepository } from "./chat/data.ts";

const kv = await Deno.openKv();

const stateKey: Deno.KvKey = ["tasktimer", "state"];
const documentPrefix: Deno.KvKey = ["tasktimer", "documents"];
const legacyMigrationKey: Deno.KvKey = [
  "tasktimer",
  "migrations",
  "legacy-state-v1",
];
const maxRequestBytes = 64 * 1024;

const staticFiles = new Map<string, { path: string; contentType: string }>([
  ["/", { path: "index.html", contentType: "text/html; charset=utf-8" }],
  ["/index.html", {
    path: "index.html",
    contentType: "text/html; charset=utf-8",
  }],
  ["/client.js", {
    path: "client.js",
    contentType: "text/javascript; charset=utf-8",
  }],
  ["/styles.css", {
    path: "styles.css",
    contentType: "text/css; charset=utf-8",
  }],
  ["/chat/client.js", {
    path: "chat/client.js",
    contentType: "text/javascript; charset=utf-8",
  }],
  ["/chat/styles.css", {
    path: "chat/styles.css",
    contentType: "text/css; charset=utf-8",
  }],
]);

type AppState = {
  stocks: Array<{ id: string; name: string }>;
  timeline: Array<
    { id: string; stockId: string; nameSnapshot: string; seconds: number }
  >;
};

type TimerDocument = {
  id: string;
  name: string;
  state: AppState;
  createdAt: string;
  updatedAt: string;
};

export interface RequestDependencies {
  chatAuthHandler?: (request: Request) => Promise<Response>;
}

export async function handleRequest(
  request: Request,
  dependencies: RequestDependencies = {},
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/api/chat/health") {
    if (request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed" }, 405, {
        Allow: "GET",
      });
    }
    return jsonResponse({ ok: true, service: "chat" }, 200, {
      "cache-control": "no-store",
    });
  }

  if (
    url.pathname === "/api/chat/auth/request-otp" ||
    url.pathname === "/api/chat/auth/verify-otp"
  ) {
    return await (dependencies.chatAuthHandler ?? handleProductionChatAuth)(
      request,
    );
  }

  if (url.pathname.startsWith("/api/chat/")) {
    return jsonResponse({ error: "Not found" }, 404);
  }

  if (url.pathname === "/api/documents") {
    return handleDocumentCollectionRequest(request);
  }

  const documentMatch = url.pathname.match(
    /^\/api\/documents\/([a-zA-Z0-9_-]{1,100})$/,
  );
  if (documentMatch) {
    return handleDocumentRequest(request, documentMatch[1]);
  }

  if (url.pathname === "/api/state") {
    return handleStateRequest(request);
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse({ error: "Method not allowed" }, 405, {
      Allow: "GET, HEAD",
    });
  }

  const file = staticFiles.get(url.pathname) ||
    (url.pathname === "/chat" || url.pathname.startsWith("/chat/")
      ? { path: "chat/index.html", contentType: "text/html; charset=utf-8" }
      : undefined);
  if (!file) return new Response("Not found", { status: 404 });

  try {
    const body = await Deno.readFile(new URL(file.path, import.meta.url));
    return new Response(request.method === "HEAD" ? null : body, {
      headers: {
        "content-type": file.contentType,
        "cache-control": file.path === "index.html"
          ? "no-cache"
          : "public, max-age=3600",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    console.error("Failed to serve static file", error);
    return new Response("Internal server error", { status: 500 });
  }
}

if (import.meta.main) {
  Deno.serve((request) => handleRequest(request));
}

let productionChatAuthHandler:
  | ((request: Request) => Promise<Response>)
  | null = null;

async function handleProductionChatAuth(request: Request): Promise<Response> {
  try {
    if (!productionChatAuthHandler) {
      const authSecret = Deno.env.get("AUTH_SECRET") ?? "";
      const resendApiKey = Deno.env.get("RESEND_API_KEY") ?? "";
      const emailFrom = Deno.env.get("EMAIL_FROM") ?? "";
      const service = new OtpAuthService({
        repository: new ChatRepository(kv),
        mailer: new ResendOtpMailer({ apiKey: resendApiKey, from: emailFrom }),
        authSecret,
      });
      productionChatAuthHandler = createOtpAuthHandler(service);
    }
    return await productionChatAuthHandler(request);
  } catch {
    return jsonResponse({ error: "Authentication is not configured" }, 503, {
      "cache-control": "no-store",
    });
  }
}

async function handleDocumentCollectionRequest(
  request: Request,
): Promise<Response> {
  if (request.method === "GET") {
    await migrateLegacyState();
    const documents: Array<Pick<TimerDocument, "id" | "name" | "updatedAt">> =
      [];
    for await (
      const entry of kv.list<TimerDocument>({ prefix: documentPrefix })
    ) {
      const document = entry.value;
      if (!document?.id || !document?.name || !document?.updatedAt) continue;
      documents.push({
        id: document.id,
        name: document.name,
        updatedAt: document.updatedAt,
      });
    }
    documents.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return jsonResponse({ documents }, 200, { "cache-control": "no-store" });
  }

  if (request.method === "POST") {
    const input = await readDocumentInput(request);
    if (input instanceof Response) return input;

    const now = new Date().toISOString();
    const document: TimerDocument = {
      id: crypto.randomUUID(),
      name: input.name,
      state: input.state,
      createdAt: now,
      updatedAt: now,
    };
    await kv.set([...documentPrefix, document.id], document);
    return jsonResponse({ document }, 201);
  }

  return jsonResponse({ error: "Method not allowed" }, 405, {
    Allow: "GET, POST",
  });
}

async function handleDocumentRequest(
  request: Request,
  id: string,
): Promise<Response> {
  const key: Deno.KvKey = [...documentPrefix, id];

  if (request.method === "GET") {
    const entry = await kv.get<TimerDocument>(key);
    if (!entry.value) return jsonResponse({ error: "Document not found" }, 404);
    return jsonResponse({ document: entry.value }, 200, {
      "cache-control": "no-store",
    });
  }

  if (request.method === "PUT") {
    const existing = await kv.get<TimerDocument>(key);
    if (!existing.value) {
      return jsonResponse({ error: "Document not found" }, 404);
    }

    const input = await readDocumentInput(request);
    if (input instanceof Response) return input;

    const document: TimerDocument = {
      ...existing.value,
      name: input.name,
      state: input.state,
      updatedAt: new Date().toISOString(),
    };
    await kv.set(key, document);
    return jsonResponse({ document });
  }

  return jsonResponse({ error: "Method not allowed" }, 405, {
    Allow: "GET, PUT",
  });
}

async function readDocumentInput(
  request: Request,
): Promise<{ name: string; state: AppState } | Response> {
  const parsed = await readJsonBody(request);
  if (parsed instanceof Response) return parsed;
  if (!parsed || typeof parsed !== "object") {
    return jsonResponse({ error: "Invalid document" }, 400);
  }

  const candidate = parsed as Record<string, unknown>;
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const state = normalizeState(candidate.state);
  if (!name || name.length > 80 || !state) {
    return jsonResponse({ error: "Invalid document" }, 400);
  }
  return { name, state };
}

async function readJsonBody(request: Request): Promise<unknown | Response> {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > maxRequestBytes) {
    return jsonResponse({ error: "Request body is too large" }, 413);
  }

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return jsonResponse({ error: "Could not read request body" }, 400);
  }

  if (new TextEncoder().encode(bodyText).byteLength > maxRequestBytes) {
    return jsonResponse({ error: "Request body is too large" }, 413);
  }

  try {
    return JSON.parse(bodyText);
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
}

async function migrateLegacyState(): Promise<void> {
  const migration = await kv.get(legacyMigrationKey);
  if (migration.value) return;

  const legacy = await kv.get<AppState>(stateKey);
  const state = normalizeState(legacy.value);
  const mutations = kv.atomic().check(migration).set(legacyMigrationKey, true);
  if (state) {
    const now = new Date().toISOString();
    const document: TimerDocument = {
      id: "legacy-state",
      name: "以前のタイマー",
      state,
      createdAt: now,
      updatedAt: now,
    };
    mutations.set([...documentPrefix, document.id], document);
  }
  await mutations.commit();
}

async function handleStateRequest(request: Request): Promise<Response> {
  if (request.method === "GET") {
    const entry = await kv.get<AppState>(stateKey);
    return jsonResponse({ state: entry.value }, 200, {
      "cache-control": "no-store",
    });
  }

  if (request.method === "PUT") {
    const parsed = await readJsonBody(request);
    if (parsed instanceof Response) return parsed;

    const state = normalizeState(parsed);
    if (!state) return jsonResponse({ error: "Invalid task state" }, 400);

    await kv.set(stateKey, state);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: "Method not allowed" }, 405, {
    Allow: "GET, PUT",
  });
}

function normalizeState(value: unknown): AppState | null {
  if (!value || typeof value !== "object") return null;

  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.stocks) || !Array.isArray(candidate.timeline)) {
    return null;
  }
  if (candidate.stocks.length > 1000 || candidate.timeline.length > 1000) {
    return null;
  }

  const stocks: AppState["stocks"] = [];
  for (const value of candidate.stocks) {
    if (!value || typeof value !== "object") return null;
    const stock = value as Record<string, unknown>;
    const id = typeof stock.id === "string" ? stock.id : "";
    const name = typeof stock.name === "string" ? stock.name.trim() : "";
    if (!id || id.length > 100 || !name || name.length > 80) return null;
    stocks.push({ id, name });
  }

  const timeline: AppState["timeline"] = [];
  for (const value of candidate.timeline) {
    if (!value || typeof value !== "object") return null;
    const task = value as Record<string, unknown>;
    const id = typeof task.id === "string" ? task.id : "";
    const stockId = typeof task.stockId === "string" ? task.stockId : "";
    const nameSnapshot = typeof task.nameSnapshot === "string"
      ? task.nameSnapshot.trim()
      : "";
    const seconds = typeof task.seconds === "number" ? task.seconds : 0;
    if (
      !id || id.length > 100 || stockId.length > 100 || nameSnapshot.length > 80
    ) return null;
    if (!stockId && !nameSnapshot) return null;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 59999) {
      return null;
    }
    timeline.push({ id, stockId, nameSnapshot, seconds });
  }

  return { stocks, timeline };
}

function jsonResponse(
  value: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return Response.json(value, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}
