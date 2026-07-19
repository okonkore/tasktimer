const storageKey = "read-aloud-task-timer-v2";
const legacyStorageKey = "read-aloud-task-timer-v1";
const dirtyStorageKey = "read-aloud-task-timer-v2-dirty";
const documentIdStorageKey = "read-aloud-task-timer-v2-document-id";
const documentNameStorageKey = "read-aloud-task-timer-v2-document-name";
const documentsEndpoint = "/api/documents";
const announcementThresholds = [1800, 900, 600, 300, 180, 60, 30, 10];

const els = {
  timerView: document.querySelector("#timerView"),
  stockView: document.querySelector("#stockView"),
  openStock: document.querySelector("#openStockBtn"),
  backToTimer: document.querySelector("#backToTimerBtn"),
  addStock: document.querySelector("#addStockBtn"),
  newDocument: document.querySelector("#newDocumentBtn"),
  openDocument: document.querySelector("#openDocumentBtn"),
  saveDocument: document.querySelector("#saveDocumentBtn"),
  currentDocumentName: document.querySelector("#currentDocumentName"),
  documentStatus: document.querySelector("#documentStatus"),
  timerStatus: document.querySelector("#timerStatus"),
  currentTaskName: document.querySelector("#currentTaskName"),
  timeDisplay: document.querySelector("#timeDisplay"),
  progressFill: document.querySelector("#progressFill"),
  startPause: document.querySelector("#startPauseBtn"),
  reset: document.querySelector("#resetBtn"),
  next: document.querySelector("#nextBtn"),
  taskList: document.querySelector("#taskList"),
  taskCount: document.querySelector("#taskCount"),
  emptyState: document.querySelector("#emptyState"),
  stockList: document.querySelector("#stockList"),
  stockCount: document.querySelector("#stockCount"),
  stockEmptyState: document.querySelector("#stockEmptyState"),
  timeDialog: document.querySelector("#timeDialog"),
  timeForm: document.querySelector("#timeForm"),
  timeDialogTitle: document.querySelector("#timeDialogTitle"),
  closeTimeDialog: document.querySelector("#closeTimeDialogBtn"),
  cancelTimeDialog: document.querySelector("#cancelTimeDialogBtn"),
  saveTime: document.querySelector("#saveTimeBtn"),
  selectedStockName: document.querySelector("#selectedStockName"),
  minutesInput: document.querySelector("#taskMinutesInput"),
  secondsInput: document.querySelector("#taskSecondsInput"),
  timeFormError: document.querySelector("#timeFormError"),
  stockDialog: document.querySelector("#stockDialog"),
  stockForm: document.querySelector("#stockForm"),
  stockDialogTitle: document.querySelector("#stockDialogTitle"),
  closeStockDialog: document.querySelector("#closeStockDialogBtn"),
  cancelStockDialog: document.querySelector("#cancelStockDialogBtn"),
  stockNameInput: document.querySelector("#stockNameInput"),
  stockFormError: document.querySelector("#stockFormError"),
  documentNameDialog: document.querySelector("#documentNameDialog"),
  documentNameForm: document.querySelector("#documentNameForm"),
  documentNameDialogTitle: document.querySelector("#documentNameDialogTitle"),
  closeDocumentNameDialog: document.querySelector("#closeDocumentNameDialogBtn"),
  cancelDocumentName: document.querySelector("#cancelDocumentNameBtn"),
  confirmDocumentName: document.querySelector("#confirmDocumentNameBtn"),
  documentNameInput: document.querySelector("#documentNameInput"),
  documentNameError: document.querySelector("#documentNameError"),
  openDocumentDialog: document.querySelector("#openDocumentDialog"),
  closeOpenDocumentDialog: document.querySelector("#closeOpenDocumentDialogBtn"),
  documentList: document.querySelector("#documentList"),
  documentListEmpty: document.querySelector("#documentListEmpty"),
  documentListError: document.querySelector("#documentListError"),
};

let state = loadState();
let editingStockId = null;
let pendingStockId = null;
let editingTimelineId = null;
let activeIndex = 0;
let remainingSeconds = 0;
let totalSeconds = 0;
let announcedRemainingSeconds = new Set();
let timerId = null;
let mode = "idle";
let audioContext = null;
let draggingTaskId = null;
let draggingList = null;
let pointerDrag = null;
let currentDocumentId = localStorage.getItem(documentIdStorageKey) || null;
let currentDocumentName = localStorage.getItem(documentNameStorageKey) || "無題";
let documentDirty = localStorage.getItem(dirtyStorageKey) === "1" || !currentDocumentId;
let documentNameMode = "new";

render();
resetTimerState();
updateDocumentHeader();

function loadState() {
  try {
    const raw = localStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") {
      return {
        stocks: Array.isArray(parsed.stocks) ? parsed.stocks.map(normalizeStock).filter(Boolean) : [],
        timeline: Array.isArray(parsed.timeline) ? parsed.timeline.map(normalizeTimelineTask).filter(Boolean) : [],
      };
    }
  } catch {
    localStorage.removeItem(storageKey);
  }

  const migrated = loadLegacyTasks();
  if (migrated.timeline.length || migrated.stocks.length) return migrated;

  const stretch = makeStock("ストレッチ");
  const rest = makeStock("休憩");
  return {
    stocks: [stretch, rest],
    timeline: [makeTimelineTask(stretch, 30), makeTimelineTask(rest, 15)],
  };
}

function loadLegacyTasks() {
  try {
    const raw = localStorage.getItem(legacyStorageKey);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return { stocks: [], timeline: [] };

    const stocks = [];
    const timeline = [];
    parsed.forEach((task) => {
      const name = String(task?.name || "").trim().slice(0, 80);
      const seconds = Math.max(0, Math.round(Number(task?.seconds) || 0));
      if (!name || seconds <= 0) return;
      const stock = makeStock(name);
      stocks.push(stock);
      timeline.push(makeTimelineTask(stock, seconds));
    });
    return { stocks, timeline };
  } catch {
    return { stocks: [], timeline: [] };
  }
}

function normalizeStock(stock) {
  const name = String(stock?.name || "").trim();
  if (!name) return null;
  return {
    id: String(stock.id || crypto.randomUUID()),
    name: name.slice(0, 80),
  };
}

function normalizeTimelineTask(task) {
  const seconds = Math.max(0, Math.round(Number(task?.seconds) || 0));
  const stockId = String(task?.stockId || "");
  const name = String(task?.name || task?.nameSnapshot || "").trim();
  if (seconds <= 0 || (!stockId && !name)) return null;
  return {
    id: String(task.id || crypto.randomUUID()),
    stockId,
    nameSnapshot: name.slice(0, 80),
    seconds,
  };
}

function makeStock(name = "") {
  return {
    id: crypto.randomUUID(),
    name: String(name).trim().slice(0, 80),
  };
}

function makeTimelineTask(stock, seconds) {
  return {
    id: crypto.randomUUID(),
    stockId: stock.id,
    nameSnapshot: stock.name,
    seconds: Math.max(1, Math.round(Number(seconds) || 0)),
  };
}

function saveState() {
  localStorage.setItem(storageKey, JSON.stringify(state));
  localStorage.setItem(dirtyStorageKey, "1");
  documentDirty = true;
  updateDocumentHeader();
}

function updateDocumentHeader(message = "") {
  els.currentDocumentName.textContent = currentDocumentName;
  els.documentStatus.textContent = message || (documentDirty ? "未保存" : "保存済み");
}

function normalizeRemoteState(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  if (!Array.isArray(candidate.stocks) || !Array.isArray(candidate.timeline)) return null;

  return {
    stocks: candidate.stocks.map(normalizeStock).filter(Boolean),
    timeline: candidate.timeline.map(normalizeTimelineTask).filter(Boolean),
  };
}

function openDocumentNameDialog(mode) {
  if (mode === "new" && documentDirty && !confirm("未保存の変更があります。新規作成しますか？")) return;

  documentNameMode = mode;
  els.documentNameDialogTitle.textContent = mode === "new" ? "新規作成" : "名前を付けて保存";
  els.confirmDocumentName.textContent = mode === "new" ? "作成" : "保存";
  els.documentNameInput.value = mode === "new" ? "無題" : currentDocumentName;
  els.documentNameError.textContent = "";
  showDialog(els.documentNameDialog);
  setTimeout(() => els.documentNameInput.select(), 0);
}

function closeDocumentNameDialog() {
  closeDialog(els.documentNameDialog);
}

async function submitDocumentName(event) {
  event.preventDefault();
  const name = els.documentNameInput.value.trim();
  if (!name) {
    els.documentNameError.textContent = "ファイル名を入力してください";
    return;
  }

  if (documentNameMode === "new") {
    currentDocumentId = null;
    currentDocumentName = name.slice(0, 80);
    state = { stocks: [], timeline: [] };
    documentDirty = true;
    localStorage.removeItem(documentIdStorageKey);
    localStorage.setItem(documentNameStorageKey, currentDocumentName);
    localStorage.setItem(storageKey, JSON.stringify(state));
    localStorage.setItem(dirtyStorageKey, "1");
    closeDocumentNameDialog();
    showTimerView();
    resetTimerState(0);
    updateDocumentHeader();
    return;
  }

  await persistCurrentDocument(name.slice(0, 80), true);
  if (!documentDirty) closeDocumentNameDialog();
}

async function saveCurrentDocument() {
  if (!currentDocumentId) {
    openDocumentNameDialog("save");
    return;
  }
  await persistCurrentDocument(currentDocumentName, false);
}

async function persistCurrentDocument(name, create) {
  const serializedState = JSON.stringify(state);
  els.saveDocument.disabled = true;
  updateDocumentHeader("保存中…");

  try {
    const response = await fetch(create ? documentsEndpoint : `${documentsEndpoint}/${currentDocumentId}`, {
      method: create ? "POST" : "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, state }),
    });
    if (!response.ok) throw new Error(`Document save failed: ${response.status}`);
    const payload = await response.json();
    if (!payload?.document?.id) throw new Error("Invalid save response");

    currentDocumentId = payload.document.id;
    currentDocumentName = payload.document.name;
    localStorage.setItem(documentIdStorageKey, currentDocumentId);
    localStorage.setItem(documentNameStorageKey, currentDocumentName);
    if (JSON.stringify(state) === serializedState) {
      documentDirty = false;
      localStorage.removeItem(dirtyStorageKey);
    } else {
      documentDirty = true;
      localStorage.setItem(dirtyStorageKey, "1");
    }
    updateDocumentHeader();
  } catch (error) {
    console.warn("ファイルをサーバーへ保存できませんでした", error);
    els.documentNameError.textContent = create ? "保存できませんでした。もう一度お試しください" : "";
    updateDocumentHeader("保存に失敗しました");
  } finally {
    els.saveDocument.disabled = false;
  }
}

async function showOpenDocumentDialog() {
  els.documentList.innerHTML = "";
  els.documentListEmpty.hidden = true;
  els.documentListError.textContent = "読み込み中…";
  showDialog(els.openDocumentDialog);

  try {
    const response = await fetch(documentsEndpoint, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) throw new Error(`Document list failed: ${response.status}`);
    const payload = await response.json();
    const documents = Array.isArray(payload?.documents) ? payload.documents : [];
    els.documentListError.textContent = "";
    els.documentListEmpty.hidden = documents.length > 0;
    documents.forEach(renderDocumentListItem);
  } catch (error) {
    console.warn("ファイル一覧を読み込めませんでした", error);
    els.documentListError.textContent = "ファイル一覧を読み込めませんでした";
  }
}

function renderDocumentListItem(savedDocument) {
  const item = document.createElement("article");
  item.className = "document-list-item";

  const main = document.createElement("div");
  main.className = "document-list-main";
  const name = document.createElement("strong");
  name.textContent = String(savedDocument.name || "無題");
  const updated = document.createElement("small");
  const updatedAt = new Date(savedDocument.updatedAt);
  updated.textContent = Number.isNaN(updatedAt.getTime()) ? "" : updatedAt.toLocaleString("ja-JP");
  main.append(name, updated);

  const open = document.createElement("button");
  open.className = "small-button";
  open.type = "button";
  open.textContent = "開く";
  open.addEventListener("click", () => void loadDocument(savedDocument.id));
  item.append(main, open);
  els.documentList.append(item);
}

async function loadDocument(id) {
  if (documentDirty && !confirm("未保存の変更があります。別のファイルを開きますか？")) return;
  els.documentListError.textContent = "読み込み中…";

  try {
    const response = await fetch(`${documentsEndpoint}/${encodeURIComponent(id)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Document load failed: ${response.status}`);
    const payload = await response.json();
    const loadedState = normalizeRemoteState(payload?.document?.state);
    if (!loadedState || !payload?.document?.id) throw new Error("Invalid document response");

    state = loadedState;
    currentDocumentId = payload.document.id;
    currentDocumentName = String(payload.document.name || "無題");
    documentDirty = false;
    localStorage.setItem(storageKey, JSON.stringify(state));
    localStorage.setItem(documentIdStorageKey, currentDocumentId);
    localStorage.setItem(documentNameStorageKey, currentDocumentName);
    localStorage.removeItem(dirtyStorageKey);
    closeDialog(els.openDocumentDialog);
    showTimerView();
    resetTimerState(0);
    updateDocumentHeader();
  } catch (error) {
    console.warn("ファイルを開けませんでした", error);
    els.documentListError.textContent = "ファイルを開けませんでした";
  }
}

function render() {
  renderTimeline();
  renderStocks();
  updateDisplay();
}

function renderTimeline() {
  els.taskList.innerHTML = "";
  const totalTimelineSeconds = state.timeline.reduce((sum, task) => sum + task.seconds, 0);
  els.taskCount.textContent = `${state.timeline.length}件 / 合計 ${formatDuration(totalTimelineSeconds)}`;
  els.emptyState.hidden = state.timeline.length > 0;

  state.timeline.forEach((task, index) => {
    const item = document.createElement("article");
    item.className = "task-item";
    item.draggable = true;
    item.dataset.id = task.id;
    item.dataset.list = "timeline";
    if (index === activeIndex && mode !== "idle") item.classList.add("active");
    if (task.id === draggingTaskId && draggingList === "timeline") item.classList.add("dragging");

    const handle = document.createElement("button");
    handle.className = "drag-handle";
    handle.type = "button";
    handle.title = "並び替え";
    handle.setAttribute("aria-label", "並び替え");
    handle.addEventListener("pointerdown", (event) => beginPointerDrag(event, "timeline", task.id));

    const main = document.createElement("div");
    main.className = "task-main";

    const name = document.createElement("div");
    name.className = "task-name";
    name.textContent = getTimelineTaskName(task);

    const time = document.createElement("div");
    time.className = "task-time";
    time.textContent = formatDuration(task.seconds);

    main.append(name, time);

    const actions = document.createElement("div");
    actions.className = "task-actions";

    const editTime = document.createElement("button");
    editTime.className = "small-button";
    editTime.type = "button";
    editTime.textContent = "時間";
    editTime.addEventListener("click", () => openTimelineTimeDialog(task.id));

    const remove = document.createElement("button");
    remove.className = "small-button delete";
    remove.type = "button";
    remove.textContent = "削除";
    remove.addEventListener("click", () => deleteTimelineTask(task.id));

    actions.append(editTime, remove);
    item.append(handle, main, actions);

    item.addEventListener("dragstart", (event) => {
      draggingTaskId = task.id;
      draggingList = "timeline";
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", task.id);
      event.dataTransfer.setData("application/x-task-list", "timeline");
      render();
    });

    item.addEventListener("dragover", (event) => {
      event.preventDefault();
      const fromId = event.dataTransfer.getData("text/plain") || draggingTaskId;
      const fromList = event.dataTransfer.getData("application/x-task-list") || draggingList;
      if (fromList === "timeline" && fromId && fromId !== task.id) reorderTimelineTask(fromId, task.id);
    });

    item.addEventListener("dragend", () => {
      draggingTaskId = null;
      draggingList = null;
      render();
    });

    els.taskList.append(item);
  });
}

function renderStocks() {
  els.stockList.innerHTML = "";
  els.stockCount.textContent = `${state.stocks.length}件`;
  els.stockEmptyState.hidden = state.stocks.length > 0;

  state.stocks.forEach((stock) => {
    const item = document.createElement("article");
    item.className = "task-item stock-item";
    item.draggable = true;
    item.dataset.id = stock.id;
    item.dataset.list = "stock";
    if (stock.id === draggingTaskId && draggingList === "stock") item.classList.add("dragging");

    const handle = document.createElement("button");
    handle.className = "drag-handle";
    handle.type = "button";
    handle.title = "並び替え";
    handle.setAttribute("aria-label", "並び替え");
    handle.addEventListener("pointerdown", (event) => beginPointerDrag(event, "stock", stock.id));

    const main = document.createElement("div");
    main.className = "task-main";

    const name = document.createElement("div");
    name.className = "task-name";
    name.textContent = stock.name;

    const meta = document.createElement("div");
    meta.className = "task-time";
    meta.textContent = "ストックタスク";

    main.append(name, meta);

    const actions = document.createElement("div");
    actions.className = "task-actions";

    const add = document.createElement("button");
    add.className = "small-button";
    add.type = "button";
    add.textContent = "追加";
    add.addEventListener("click", () => openTimeDialog(stock.id));

    const edit = document.createElement("button");
    edit.className = "small-button";
    edit.type = "button";
    edit.textContent = "編集";
    edit.addEventListener("click", () => openStockDialog(stock.id));

    const remove = document.createElement("button");
    remove.className = "small-button delete";
    remove.type = "button";
    remove.textContent = "削除";
    remove.addEventListener("click", () => deleteStock(stock.id));

    actions.append(add, edit, remove);
    item.append(handle, main, actions);

    item.addEventListener("dragstart", (event) => {
      draggingTaskId = stock.id;
      draggingList = "stock";
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", stock.id);
      event.dataTransfer.setData("application/x-task-list", "stock");
      render();
    });

    item.addEventListener("dragover", (event) => {
      event.preventDefault();
      const fromId = event.dataTransfer.getData("text/plain") || draggingTaskId;
      const fromList = event.dataTransfer.getData("application/x-task-list") || draggingList;
      if (fromList === "stock" && fromId && fromId !== stock.id) reorderStock(fromId, stock.id);
    });

    item.addEventListener("dragend", () => {
      draggingTaskId = null;
      draggingList = null;
      render();
    });

    els.stockList.append(item);
  });
}

function getTimelineTaskName(task) {
  return state.stocks.find((stock) => stock.id === task.stockId)?.name || task.nameSnapshot || "削除済みストック";
}

function updateDisplay() {
  const current = state.timeline[activeIndex];

  if (!current) {
    els.timerStatus.textContent = "待機中";
    els.currentTaskName.textContent = "ストックからタスクを追加してください";
    els.timeDisplay.textContent = "00:00";
    els.progressFill.style.width = "0%";
    els.startPause.textContent = "開始";
    els.startPause.disabled = true;
    els.reset.disabled = true;
    els.next.disabled = true;
    return;
  }

  els.startPause.disabled = false;
  els.reset.disabled = mode === "idle";
  els.next.disabled = mode === "idle" || mode === "complete";
  els.startPause.disabled = mode === "complete";
  els.startPause.textContent = mode === "running" ? "一時停止" : mode === "paused" ? "再開" : "開始";

  const status = {
    idle: "待機中",
    running: `${activeIndex + 1} / ${state.timeline.length}`,
    paused: "一時停止中",
    complete: "完了",
  };

  els.timerStatus.textContent = status[mode] || "待機中";
  els.currentTaskName.textContent = getTimelineTaskName(current);
  els.timeDisplay.textContent = formatClock(remainingSeconds || current.seconds);

  const base = totalSeconds || current.seconds;
  const done = base > 0 ? Math.max(0, Math.min(1, (base - remainingSeconds) / base)) : 0;
  els.progressFill.style.width = `${done * 100}%`;
}

function resetTimerState(index = 0) {
  stopTicker();
  activeIndex = Math.min(Math.max(index, 0), Math.max(state.timeline.length - 1, 0));
  const current = state.timeline[activeIndex];
  remainingSeconds = current?.seconds || 0;
  totalSeconds = current?.seconds || 0;
  resetAnnouncementMarkers();
  mode = "idle";
  render();
}

function startOrPause() {
  ensureMediaReady();

  if (mode === "running") {
    pauseTimer();
    return;
  }

  if (!state.timeline.length) return;
  if (mode === "idle") {
    activeIndex = Math.min(activeIndex, state.timeline.length - 1);
    remainingSeconds = state.timeline[activeIndex].seconds;
    totalSeconds = state.timeline[activeIndex].seconds;
    resetAnnouncementMarkers();
    speakTimelineStart("最初は", state.timeline[activeIndex]);
  }

  startTimer();
}

function startTimer() {
  mode = "running";
  stopTicker();
  timerId = window.setInterval(tick, 1000);
  render();
}

function pauseTimer() {
  mode = "paused";
  stopTicker();
  render();
}

function tick() {
  remainingSeconds -= 1;
  if (remainingSeconds <= 0) {
    remainingSeconds = 0;
    updateDisplay();
    completeCurrentTask();
    return;
  }
  announceRemainingTime();
  updateDisplay();
}

function announceRemainingTime() {
  if (!announcementThresholds.includes(remainingSeconds)) return;
  if (announcedRemainingSeconds.has(remainingSeconds)) return;

  announcedRemainingSeconds.add(remainingSeconds);
  speak(`残り${formatAnnouncementTime(remainingSeconds)}です`);
}

function speakTimelineStart(prefix, task) {
  speak(`${prefix}、${getTimelineTaskName(task)}、${formatDuration(task.seconds)}です`);
}

function completeCurrentTask() {
  stopTicker();
  playAlarm();

  const nextIndex = activeIndex + 1;
  if (nextIndex >= state.timeline.length) {
    mode = "complete";
    speak("おつかれさまでした");
    updateDisplay();
    setTimeout(() => resetTimerState(0), 1200);
    return;
  }

  activeIndex = nextIndex;
  remainingSeconds = state.timeline[activeIndex].seconds;
  totalSeconds = state.timeline[activeIndex].seconds;
  resetAnnouncementMarkers();
  speakTimelineStart("次は", state.timeline[activeIndex]);
  startTimer();
}

function skipToNext() {
  ensureMediaReady();
  if (mode === "idle" || !state.timeline.length) return;
  completeCurrentTask();
}

function stopTicker() {
  if (timerId) window.clearInterval(timerId);
  timerId = null;
}

function resetAnnouncementMarkers() {
  announcedRemainingSeconds = new Set();
}

function showTimerView() {
  els.stockView.classList.remove("active");
  els.timerView.classList.add("active");
}

function showStockView() {
  els.timerView.classList.remove("active");
  els.stockView.classList.add("active");
}

function openTimeDialog(stockId) {
  const stock = state.stocks.find((item) => item.id === stockId);
  if (!stock) return;

  pendingStockId = stockId;
  editingTimelineId = null;
  els.timeDialogTitle.textContent = "時間を設定";
  els.saveTime.textContent = "タイムラインへ追加";
  els.selectedStockName.textContent = stock.name;
  els.minutesInput.value = "1";
  els.secondsInput.value = "0";
  els.timeFormError.textContent = "";
  showDialog(els.timeDialog);
  setTimeout(() => els.minutesInput.focus(), 0);
}

function openTimelineTimeDialog(taskId) {
  const task = state.timeline.find((item) => item.id === taskId);
  if (!task) return;

  editingTimelineId = taskId;
  pendingStockId = null;
  els.timeDialogTitle.textContent = "時間を編集";
  els.saveTime.textContent = "時間を保存";
  els.selectedStockName.textContent = getTimelineTaskName(task);
  els.minutesInput.value = String(Math.floor(task.seconds / 60));
  els.secondsInput.value = String(task.seconds % 60);
  els.timeFormError.textContent = "";
  showDialog(els.timeDialog);
  setTimeout(() => els.minutesInput.focus(), 0);
}

function closeTimeDialog() {
  pendingStockId = null;
  editingTimelineId = null;
  closeDialog(els.timeDialog);
}

function submitTimelineTask(event) {
  event.preventDefault();
  const stock = state.stocks.find((item) => item.id === pendingStockId);
  const timelineTask = state.timeline.find((item) => item.id === editingTimelineId);
  const minutes = clampInteger(els.minutesInput.value, 0, 999);
  const seconds = clampInteger(els.secondsInput.value, 0, 59);
  const total = minutes * 60 + seconds;

  if (!stock && !timelineTask) {
    els.timeFormError.textContent = "ストックタスクを選び直してください";
    return;
  }

  if (total <= 0) {
    els.timeFormError.textContent = "時間は1秒以上にしてください";
    return;
  }

  if (timelineTask) {
    timelineTask.seconds = total;
  } else {
    state.timeline.push(makeTimelineTask(stock, total));
  }

  saveState();
  const editedActiveTask = timelineTask?.id === state.timeline[activeIndex]?.id;
  closeTimeDialog();
  showTimerView();
  if (mode === "idle" || mode === "complete" || editedActiveTask) resetTimerState(activeIndex);
  render();
}

function openStockDialog(id = null) {
  const stock = id ? state.stocks.find((item) => item.id === id) : null;
  editingStockId = stock?.id || null;
  els.stockDialogTitle.textContent = stock ? "ストックを編集" : "ストックを追加";
  els.stockNameInput.value = stock?.name || "";
  els.stockFormError.textContent = "";
  showDialog(els.stockDialog);
  setTimeout(() => els.stockNameInput.focus(), 0);
}

function closeStockDialog() {
  editingStockId = null;
  closeDialog(els.stockDialog);
}

function submitStock(event) {
  event.preventDefault();
  const name = els.stockNameInput.value.trim();

  if (!name) {
    els.stockFormError.textContent = "やることを入力してください";
    return;
  }

  if (editingStockId) {
    const stock = state.stocks.find((item) => item.id === editingStockId);
    if (stock) stock.name = name.slice(0, 80);
  } else {
    state.stocks.push(makeStock(name));
  }

  saveState();
  closeStockDialog();
  render();
}

function deleteStock(id) {
  const index = state.stocks.findIndex((stock) => stock.id === id);
  if (index < 0) return;
  state.stocks.splice(index, 1);
  saveState();
  render();
}

function deleteTimelineTask(id) {
  const index = state.timeline.findIndex((task) => task.id === id);
  if (index < 0) return;

  const wasActive = index === activeIndex;
  state.timeline.splice(index, 1);
  if (activeIndex >= state.timeline.length) activeIndex = Math.max(0, state.timeline.length - 1);
  saveState();

  if (!state.timeline.length) {
    resetTimerState(0);
    return;
  }

  if (mode === "idle" || wasActive) resetTimerState(activeIndex);
  render();
}

function reorderTimelineTask(fromId, toId) {
  const fromIndex = state.timeline.findIndex((task) => task.id === fromId);
  const toIndex = state.timeline.findIndex((task) => task.id === toId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;

  const activeId = state.timeline[activeIndex]?.id;
  const [moved] = state.timeline.splice(fromIndex, 1);
  state.timeline.splice(toIndex, 0, moved);
  activeIndex = Math.max(0, state.timeline.findIndex((task) => task.id === activeId));
  saveState();
  render();
}

function reorderStock(fromId, toId) {
  const fromIndex = state.stocks.findIndex((stock) => stock.id === fromId);
  const toIndex = state.stocks.findIndex((stock) => stock.id === toId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;

  const [moved] = state.stocks.splice(fromIndex, 1);
  state.stocks.splice(toIndex, 0, moved);
  saveState();
  render();
}

function beginPointerDrag(event, list, taskId) {
  event.preventDefault();
  pointerDrag = { list, taskId };
  draggingTaskId = taskId;
  draggingList = list;
  event.currentTarget.setPointerCapture?.(event.pointerId);
  document.addEventListener("pointermove", movePointerDrag);
  document.addEventListener("pointerup", finishPointerDrag);
  document.addEventListener("pointercancel", finishPointerDrag);
  render();
}

function movePointerDrag(event) {
  if (!pointerDrag) return;
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".task-item");
  const targetId = target?.dataset.id;
  const targetList = target?.dataset.list;
  if (!targetId || targetId === pointerDrag.taskId || targetList !== pointerDrag.list) return;

  if (pointerDrag.list === "timeline") reorderTimelineTask(pointerDrag.taskId, targetId);
  if (pointerDrag.list === "stock") reorderStock(pointerDrag.taskId, targetId);
}

function finishPointerDrag() {
  pointerDrag = null;
  draggingTaskId = null;
  draggingList = null;
  document.removeEventListener("pointermove", movePointerDrag);
  document.removeEventListener("pointerup", finishPointerDrag);
  document.removeEventListener("pointercancel", finishPointerDrag);
  render();
}

function showDialog(dialog) {
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else {
    dialog.setAttribute("open", "");
  }
}

function closeDialog(dialog) {
  if (typeof dialog.close === "function") {
    dialog.close();
  } else {
    dialog.removeAttribute("open");
  }
}

function ensureMediaReady() {
  if (!audioContext) {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (AudioCtor) audioContext = new AudioCtor();
  }
  if (audioContext?.state === "suspended") audioContext.resume();
}

function playAlarm() {
  ensureMediaReady();
  if (!audioContext) return;

  const now = audioContext.currentTime;
  [0, 0.16, 0.32].forEach((offset, index) => {
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(index === 2 ? 980 : 880, now + offset);
    gain.gain.setValueAtTime(0.0001, now + offset);
    gain.gain.exponentialRampToValueAtTime(0.16, now + offset + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.11);
    osc.connect(gain);
    gain.connect(audioContext.destination);
    osc.start(now + offset);
    osc.stop(now + offset + 0.12);
  });
}

function speak(text) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "ja-JP";
  utterance.rate = 1;
  utterance.pitch = 1;
  window.speechSynthesis.speak(utterance);
}

function formatAnnouncementTime(seconds) {
  if (seconds >= 60) return `${Math.floor(seconds / 60)}分`;
  return `${seconds}秒`;
}

function formatClock(seconds) {
  const safe = Math.max(0, Math.round(seconds || 0));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes && rest) return `${minutes}分${rest}秒`;
  if (minutes) return `${minutes}分`;
  return `${rest}秒`;
}

function clampInteger(value, min, max) {
  const number = Math.floor(Number(value || 0));
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

els.openStock.addEventListener("click", showStockView);
els.backToTimer.addEventListener("click", showTimerView);
els.addStock.addEventListener("click", () => openStockDialog());
els.newDocument.addEventListener("click", () => openDocumentNameDialog("new"));
els.openDocument.addEventListener("click", () => void showOpenDocumentDialog());
els.saveDocument.addEventListener("click", () => void saveCurrentDocument());
els.startPause.addEventListener("click", startOrPause);
els.reset.addEventListener("click", () => resetTimerState(0));
els.next.addEventListener("click", skipToNext);
els.timeForm.addEventListener("submit", submitTimelineTask);
els.closeTimeDialog.addEventListener("click", closeTimeDialog);
els.cancelTimeDialog.addEventListener("click", closeTimeDialog);
els.stockForm.addEventListener("submit", submitStock);
els.closeStockDialog.addEventListener("click", closeStockDialog);
els.cancelStockDialog.addEventListener("click", closeStockDialog);
els.documentNameForm.addEventListener("submit", (event) => void submitDocumentName(event));
els.closeDocumentNameDialog.addEventListener("click", closeDocumentNameDialog);
els.cancelDocumentName.addEventListener("click", closeDocumentNameDialog);
els.closeOpenDocumentDialog.addEventListener("click", () => closeDialog(els.openDocumentDialog));

[els.timeDialog, els.stockDialog, els.documentNameDialog, els.openDocumentDialog].forEach((dialog) => {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeDialog(dialog);
  });
});
