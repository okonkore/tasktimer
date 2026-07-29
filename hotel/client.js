const endpoint = "/api/hotel/availability";
const els = {
  available: document.querySelector("#availableCount"),
  note: document.querySelector("#availabilityNote"),
  preparing: document.querySelector("#preparingCount"),
  reported: document.querySelector("#pageReportedAt"),
  checked: document.querySelector("#checkedAt"),
  checkNow: document.querySelector("#checkNow"),
  chart: document.querySelector("#historyChart"),
  chartEmpty: document.querySelector("#chartEmpty"),
  body: document.querySelector("#historyBody"),
  historyEmpty: document.querySelector("#historyEmpty"),
  csv: document.querySelector("#downloadCsv"),
};

let records = [];
void loadHistory();

els.checkNow.addEventListener("click", checkNow);
els.csv.addEventListener("click", downloadCsv);
globalThis.addEventListener("resize", () => renderChart(records));

async function loadHistory() {
  try {
    const response = await fetch(`${endpoint}?limit=200`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    records = Array.isArray(payload.records) ? payload.records : [];
    renderLatest(payload.latest ?? records[0] ?? null);
    renderHistory(records);
    renderChart(records);
  } catch (error) {
    console.warn("空室履歴を読み込めませんでした", error);
    els.note.textContent = "履歴を読み込めませんでした";
    els.note.className = "note error";
  }
}

async function checkNow() {
  els.checkNow.disabled = true;
  els.checkNow.textContent = "確認中…";
  try {
    const response = await fetch(`${endpoint}/check`, { method: "POST" });
    const payload = await response.json();
    if (!response.ok && !payload.record) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    await loadHistory();
  } catch (error) {
    console.warn("空室状況を確認できませんでした", error);
    els.note.textContent = "確認に失敗しました。しばらくして再度お試しください";
    els.note.className = "note error";
  } finally {
    els.checkNow.disabled = false;
    els.checkNow.textContent = "今すぐ確認";
  }
}

function renderLatest(record) {
  if (!record) {
    els.note.textContent =
      "まだ記録がありません。「今すぐ確認」から開始できます";
    return;
  }
  els.checked.textContent = formatDate(record.checkedAt);
  els.reported.textContent = formatDate(record.pageReportedAt);
  if (!record.ok || !record.available) {
    els.available.textContent = "--";
    els.preparing.textContent = "--";
    els.note.textContent = record.error || "取得に失敗しました";
    els.note.className = "note error";
    return;
  }
  els.available.textContent = `${record.available.count}${
    record.available.isMinimum ? "+" : ""
  }`;
  els.preparing.textContent = record.preparing?.label ?? "--";
  els.note.textContent = record.available.count > 0
    ? `現在、${record.available.label}の空室があります`
    : "現在、空室はありません";
  els.note.className = record.available.count > 0 ? "note open" : "note";
}

function renderHistory(items) {
  els.body.replaceChildren();
  els.historyEmpty.hidden = items.length > 0;
  items.forEach((record) => {
    const row = document.createElement("tr");
    appendCell(row, formatDate(record.checkedAt));
    appendCell(row, record.available?.label ?? "--", "number");
    appendCell(row, record.preparing?.label ?? "--", "number");
    appendCell(row, formatDate(record.pageReportedAt));
    appendCell(
      row,
      record.ok ? "成功" : `失敗: ${record.error || "不明"}`,
      record.ok ? "success" : "failure",
    );
    els.body.append(row);
  });
}

function appendCell(row, text, className = "") {
  const cell = document.createElement("td");
  cell.textContent = text;
  if (className) cell.className = className;
  row.append(cell);
}

function renderChart(items) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const points = items
    .filter((item) =>
      item.ok && item.available && Date.parse(item.checkedAt) >= cutoff
    )
    .sort((a, b) => a.checkedAt.localeCompare(b.checkedAt));
  els.chart.replaceChildren();
  els.chartEmpty.hidden = points.length > 0;
  els.chart.hidden = points.length === 0;
  if (!points.length) return;

  const width = Math.max(560, els.chart.parentElement.clientWidth - 4);
  const height = 240;
  const pad = { top: 18, right: 18, bottom: 34, left: 38 };
  const maxCount = Math.max(3, ...points.map((point) => point.available.count));
  const start = Math.min(...points.map((point) => Date.parse(point.checkedAt)));
  const end = Math.max(
    Date.now(),
    ...points.map((point) => Date.parse(point.checkedAt)),
  );
  const x = (time) =>
    pad.left +
    ((time - start) / Math.max(1, end - start)) *
      (width - pad.left - pad.right);
  const y = (count) =>
    height - pad.bottom - (count / maxCount) * (height - pad.top - pad.bottom);
  els.chart.setAttribute("viewBox", `0 0 ${width} ${height}`);

  for (let count = 0; count <= maxCount; count++) {
    const line = svg("line", {
      x1: pad.left,
      x2: width - pad.right,
      y1: y(count),
      y2: y(count),
      class: "grid",
    });
    const label = svg("text", {
      x: pad.left - 9,
      y: y(count) + 4,
      class: "axis-label",
    });
    label.textContent = String(count);
    els.chart.append(line, label);
  }
  const path = svg("polyline", {
    points: points.map((point) =>
      `${x(Date.parse(point.checkedAt))},${y(point.available.count)}`
    ).join(" "),
    class: "data-line",
  });
  els.chart.append(path);
  points.forEach((point) => {
    const dot = svg("circle", {
      cx: x(Date.parse(point.checkedAt)),
      cy: y(point.available.count),
      r: 3,
      class: point.available.count > 0 ? "data-dot open" : "data-dot",
    });
    const title = svg("title", {});
    title.textContent = `${
      formatDate(point.checkedAt)
    }: ${point.available.label}`;
    dot.append(title);
    els.chart.append(dot);
  });
  const left = svg("text", { x: pad.left, y: height - 9, class: "time-label" });
  left.textContent = formatTime(start);
  const right = svg("text", {
    x: width - pad.right,
    y: height - 9,
    class: "time-label end",
  });
  right.textContent = formatTime(end);
  els.chart.append(left, right);
}

function svg(name, attributes) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  Object.entries(attributes).forEach(([key, value]) =>
    node.setAttribute(key, value)
  );
  return node;
}

function downloadCsv() {
  const rows = [
    ["確認時刻", "空室", "準備中", "サイト更新時刻", "成功", "エラー"],
    ...records.map((record) => [
      record.checkedAt,
      record.available?.label ?? "",
      record.preparing?.label ?? "",
      record.pageReportedAt ?? "",
      record.ok ? "true" : "false",
      record.error ?? "",
    ]),
  ];
  const csv = "\uFEFF" +
    rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `sara-grande-availability-${
    new Date().toISOString().slice(0, 10)
  }.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function formatDate(value) {
  if (!value) return "--";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "--"
    : new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
}

function formatTime(value) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
