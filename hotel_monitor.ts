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
    const response = await (dependencies.fetcher ?? fetch)(
      HOTEL_AVAILABILITY_URL,
      {
        headers: {
          "accept": "text/html,application/xhtml+xml",
          "user-agent":
            "ParadiseTimer-SaraGrandeMonitor/1.0 (+availability history)",
        },
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok) {
      throw new Error(`対象ページが HTTP ${response.status} を返しました`);
    }
    partial = parseHotelAvailability(await response.text());
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
