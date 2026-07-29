import {
  checkHotelAvailability,
  handleHotelMonitorRequest,
  parseHotelAvailability,
} from "./hotel_monitor.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const sampleHtml = `
<!doctype html>
<html lang="ja">
  <body>
    <div class="content epEmptyCleanRoom">
      <div class="epEmptyRoom">
        <div class="epEmptyRoomClm">空室</div>
        <div class="epEmptyRoomTxt">2室</div>
      </div>
      <div class="epCleanRoom">
        <div class="epCleanRoomClm">準備中</div>
        <div class="epCleanRoomTxt">3室以上</div>
      </div>
      <p class="epEmptyCleanRoomDate">2026/07/29 13:14 現在</p>
    </div>
  </body>
</html>`;

Deno.test("hotel availability parser extracts room counts and JST timestamp", () => {
  const parsed = parseHotelAvailability(sampleHtml);
  assert(parsed.available?.count === 2, "available room count should parse");
  assert(
    parsed.available?.isMinimum === false,
    "an exact available count should not be a minimum",
  );
  assert(parsed.preparing?.count === 3, "preparing room count should parse");
  assert(
    parsed.preparing?.isMinimum === true,
    "以上 should be preserved as a minimum count",
  );
  assert(
    parsed.pageReportedAt === "2026-07-29T04:14:00.000Z",
    "the page timestamp should be interpreted as Japan time",
  );
});

Deno.test("hotel checks store successful records and expose newest history", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const fetcher = (() =>
      Promise.resolve(
        new Response(sampleHtml, { status: 200 }),
      )) as typeof fetch;
    const record = await checkHotelAvailability({
      kv,
      fetcher,
      now: () => new Date("2026-07-29T04:15:00.000Z"),
    });
    assert(record.ok, "a parsed page should produce a successful record");
    assert(
      record.available?.label === "2室",
      "the display label should persist",
    );

    const response = await handleHotelMonitorRequest(
      new Request("http://localhost/api/hotel/availability?limit=10"),
      { kv },
    );
    assert(response.status === 200, "history should be readable");
    const body = await response.json();
    assert(body.latest.id === record.id, "latest should point to the check");
    assert(body.records.length === 1, "one history record should be returned");
  } finally {
    kv.close();
  }
});

Deno.test("hotel checks preserve failures in history", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const fetcher = (() =>
      Promise.resolve(
        new Response("unavailable", { status: 503 }),
      )) as typeof fetch;
    const record = await checkHotelAvailability({
      kv,
      fetcher,
      now: () => new Date("2026-07-29T04:20:00.000Z"),
    });
    assert(!record.ok, "an upstream error should be marked as failed");
    assert(
      record.error?.includes("HTTP 503"),
      "the upstream status should be recorded",
    );

    const response = await handleHotelMonitorRequest(
      new Request("http://localhost/api/hotel/availability"),
      { kv },
    );
    const body = await response.json();
    assert(body.records[0].ok === false, "failed checks should remain visible");
  } finally {
    kv.close();
  }
});

Deno.test("manual checks reuse a result collected less than one minute ago", async () => {
  const kv = await Deno.openKv(":memory:");
  let requests = 0;
  try {
    const fetcher = (() => {
      requests += 1;
      return Promise.resolve(new Response(sampleHtml, { status: 200 }));
    }) as typeof fetch;
    const now = () => new Date("2026-07-29T04:30:00.000Z");
    await checkHotelAvailability({ kv, fetcher, now });

    const response = await handleHotelMonitorRequest(
      new Request("http://localhost/api/hotel/availability/check", {
        method: "POST",
      }),
      { kv, fetcher, now },
    );
    const body = await response.json();
    assert(body.reused === true, "a fresh result should be reused");
    assert(requests === 1, "reusing a result should not call the hotel again");
  } finally {
    kv.close();
  }
});
