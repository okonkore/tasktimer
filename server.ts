const kv = await Deno.openKv();

const stateKey: Deno.KvKey = ["tasktimer", "state"];
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
]);

type AppState = {
  stocks: Array<{ id: string; name: string }>;
  timeline: Array<
    { id: string; stockId: string; nameSnapshot: string; seconds: number }
  >;
};

Deno.serve(async (request) => {
  const url = new URL(request.url);

  if (url.pathname === "/api/state") {
    return handleStateRequest(request);
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse({ error: "Method not allowed" }, 405, {
      Allow: "GET, HEAD",
    });
  }

  const file = staticFiles.get(url.pathname);
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
});

async function handleStateRequest(request: Request): Promise<Response> {
  if (request.method === "GET") {
    const entry = await kv.get<AppState>(stateKey);
    return jsonResponse({ state: entry.value }, 200, {
      "cache-control": "no-store",
    });
  }

  if (request.method === "PUT") {
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

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return jsonResponse({ error: "Invalid JSON" }, 400);
    }

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
