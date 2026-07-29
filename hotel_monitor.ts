export const HOTEL_AVAILABILITY_URL = "https://www.hotenavi.com/sara-gra/empty";

const historyPrefix: Deno.KvKey = ["hotel-monitor", "history"];
const latestKey: Deno.KvKey = ["hotel-monitor", "latest"];

export type RoomCount = {
  count: number;
  isMinimum: boolean;
  label: string;
};

export type HotelAvailabilityRecord = {
  id: string;
  checkedAt: string;
  pageReportedAt: string | null;
  available: RoomCount | null;
  preparing: RoomCount | null;
  ok: boolean;
  error: string | null;
  sourceUrl: string;
};

export type HotelMonitorDependencies = {
  kv: Deno.Kv;
  fetcher?: typeof fetch;
  now?: () => Date;
};

export function parseHotelAvailability(
  html: string,
): Pick<
  HotelAvailabilityRecord,
  "available" | "preparing" | "pageReportedAt"
> {
  const availableLabel = extractClassText(html, "epEmptyRoomTxt");
  if (!availableLabel) {
    throw new Error("空室数をページから読み取れませんでした");
  }

  const preparingLabel = extractClassText(html, "epCleanRoomTxt");
  const reportedLabel = extractClassText(html, "epEmptyCleanRoomDate");

  return {
    available: parseRoomCount(availableLabel, "空室"),
    preparing: preparingLabel ? parseRoomCount(preparingLabel, "準備中") : null,
    pageReportedAt: reportedLabel ? parseReportedAt(reportedLabel) : null,
  };
}

export async function checkHotelAvailability(
  dependencies: HotelMonitorDependencies,
): Promise<HotelAvailabilityRecord> {
  const now = dependencies.now?.() ?? new Date();
  const checkedAt = now.toISOString();
  let partial:
    | ReturnType<typeof parseHotelAvailability>
    | undefined;
  let error: string | null = null;

  try {
    const html = await fetchHotelHtml(
      dependencies.fetcher ?? fetch,
      dependencies.fetcher ? undefined : fetchHotelHtmlOverTls,
    );
    partial = parseHotelAvailability(html);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "取得に失敗しました";
  }

  const record: HotelAvailabilityRecord = {
    id: crypto.randomUUID(),
    checkedAt,
    pageReportedAt: partial?.pageReportedAt ?? null,
    available: partial?.available ?? null,
    preparing: partial?.preparing ?? null,
    ok: Boolean(partial),
    error,
    sourceUrl: HOTEL_AVAILABILITY_URL,
  };

  await dependencies.kv.atomic()
    .set([...historyPrefix, checkedAt, record.id], record)
    .set(latestKey, record)
    .commit();
  return record;
}

export async function fetchHotelHtml(
  fetcher: typeof fetch,
  fallback?: () => Promise<string>,
): Promise<string> {
  try {
    const response = await fetcher(HOTEL_AVAILABILITY_URL, {
      headers: {
        "accept": "text/html,application/xhtml+xml",
        "user-agent":
          "ParadiseTimer-SaraGrandeMonitor/1.0 (+availability history)",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`対象ページが HTTP ${response.status} を返しました`);
    }
    return await response.text();
  } catch (primaryError) {
    if (!fallback) throw primaryError;
    return await fallback();
  }
}

export async function fetchHotelHtmlOverTls(): Promise<string> {
  const connection = await Deno.connectTls({
    hostname: "www.hotenavi.com",
    port: 443,
  });
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    const request = new TextEncoder().encode(
      "GET /sara-gra/empty HTTP/1.0\r\n" +
        "Host: www.hotenavi.com\r\n" +
        "Accept: text/html,application/xhtml+xml\r\n" +
        "User-Agent: ParadiseTimer-SaraGrandeMonitor/1.0 (+availability history)\r\n" +
        "Connection: close\r\n\r\n",
    );
    await connection.write(request);

    while (totalBytes <= 512 * 1024) {
      const buffer = new Uint8Array(16 * 1024);
      try {
        const bytesRead = await connection.read(buffer);
        if (bytesRead === null) break;
        chunks.push(buffer.slice(0, bytesRead));
        totalBytes += bytesRead;
      } catch (cause) {
        // This server closes TLS without close_notify after sending the body.
        // Deno fetch rejects that response, but the complete HTML is already read.
        if (!chunks.length) throw cause;
        break;
      }
    }
  } finally {
    connection.close();
  }

  if (totalBytes > 512 * 1024) {
    throw new Error("対象ページの応答が大きすぎます");
  }
  const responseBytes = concatenate(chunks, totalBytes);
  const headerEnd = findSequence(
    responseBytes,
    new Uint8Array([13, 10, 13, 10]),
  );
  if (headerEnd < 0) throw new Error("対象ページのHTTP応答が不正です");

  const headers = new TextDecoder("latin1").decode(
    responseBytes.slice(0, headerEnd),
  );
  const status = headers.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i);
  if (!status) throw new Error("対象ページのHTTP状態を読み取れませんでした");
  if (Number(status[1]) < 200 || Number(status[1]) >= 300) {
    throw new Error(`対象ページが HTTP ${status[1]} を返しました`);
  }

  const html = new TextDecoder().decode(responseBytes.slice(headerEnd + 4));
  if (!html.includes("epEmptyRoomTxt")) {
    throw new Error("対象ページの応答が途中で終了しました");
  }
  return html;
}

export async function handleHotelMonitorRequest(
  request: Request,
  dependencies: HotelMonitorDependencies,
): Promise<Response> {
  const url = new URL(request.url);

  if (
    url.pathname === "/api/hotel/availability" &&
    request.method === "GET"
  ) {
    const requestedLimit = Number(url.searchParams.get("limit") ?? 200);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(1000, Math.max(1, Math.trunc(requestedLimit)))
      : 200;
    const records: HotelAvailabilityRecord[] = [];
    for await (
      const entry of dependencies.kv.list<HotelAvailabilityRecord>(
        { prefix: historyPrefix },
        { reverse: true, limit },
      )
    ) {
      if (entry.value?.checkedAt) records.push(entry.value);
    }
    const latest = await dependencies.kv.get<HotelAvailabilityRecord>(
      latestKey,
    );
    return json({ latest: latest.value, records }, 200);
  }

  if (
    url.pathname === "/api/hotel/availability/check" &&
    request.method === "POST"
  ) {
    const latest = await dependencies.kv.get<HotelAvailabilityRecord>(
      latestKey,
    );
    const lastChecked = latest.value
      ? Date.parse(latest.value.checkedAt)
      : Number.NaN;
    const now = dependencies.now?.() ?? new Date();
    if (
      Number.isFinite(lastChecked) &&
      now.getTime() - lastChecked < 60_000
    ) {
      return json({ record: latest.value, reused: true }, 200);
    }
    const record = await checkHotelAvailability({
      ...dependencies,
      now: () => now,
    });
    return json({ record, reused: false }, record.ok ? 201 : 502);
  }

  const allow = url.pathname.endsWith("/check") ? "POST" : "GET";
  return json({ error: "Method not allowed" }, 405, { Allow: allow });
}

function extractClassText(html: string, className: string): string | null {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<[^>]+class=["'][^"']*\\b${escaped}\\b[^"']*["'][^>]*>` +
      `([\\s\\S]*?)<\\/[^>]+>`,
    "i",
  );
  const match = html.match(pattern);
  if (!match) return null;
  return decodeHtml(match[1].replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function parseRoomCount(label: string, field: string): RoomCount {
  const match = label.match(/(\d+)\s*室\s*(以上)?/);
  if (!match) throw new Error(`${field}数の形式が変わりました`);
  return {
    count: Number(match[1]),
    isMinimum: Boolean(match[2]),
    label: `${match[1]}室${match[2] ?? ""}`,
  };
}

function parseReportedAt(label: string): string | null {
  const match = label.match(
    /(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/,
  );
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const value = new Date(
    `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${
      hour.padStart(2, "0")
    }:${minute}:00+09:00`,
  );
  return Number.isNaN(value.getTime()) ? null : value.toISOString();
}

function decodeHtml(value: string): string {
  return value
    .replaceAll("&nbsp;", " ")
    .replaceAll("&#160;", " ")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function concatenate(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function findSequence(haystack: Uint8Array, needle: Uint8Array): number {
  outer:
  for (let index = 0; index <= haystack.length - needle.length; index++) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function json(
  value: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return Response.json(value, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}
