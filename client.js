const storageKey = "read-aloud-task-timer-v1";

const els = {
  addTask: document.querySelector("#addTaskBtn"),
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
  dialog: document.querySelector("#taskDialog"),
  form: document.querySelector("#taskForm"),
  dialogTitle: document.querySelector("#dialogTitle"),
  closeDialog: document.querySelector("#closeDialogBtn"),
  cancelDialog: document.querySelector("#cancelDialogBtn"),
  nameInput: document.querySelector("#taskNameInput"),
  minutesInput: document.querySelector("#taskMinutesInput"),
  secondsInput: document.querySelector("#taskSecondsInput"),
  formError: document.querySelector("#formError"),
};

let tasks = loadTasks();
let editingTaskId = null;
let activeIndex = 0;
let remainingSeconds = 0;
let totalSeconds = 0;
let timerId = null;
let mode = "idle";
let audioContext = null;
let draggingTaskId = null;
let pointerDrag = null;

render();
resetTimerState();

function loadTasks() {
  try {
    const raw = localStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) return parsed.map(normalizeTask).filter(Boolean);
  } catch {
    localStorage.removeItem(storageKey);
  }

  return [
    makeTask("ストレッチ", 0, 30),
    makeTask("休憩", 0, 15),
  ];
}

function normalizeTask(task) {
  const name = String(task?.name || "").trim();
  const seconds = Math.max(0, Math.round(Number(task?.seconds) || 0));
  if (!name || seconds <= 0) return null;
  return {
    id: String(task.id || crypto.randomUUID()),
    name: name.slice(0, 80),
    seconds,
  };
}

function makeTask(name = "", minutes = 1, seconds = 0) {
  return {
    id: crypto.randomUUID(),
    name,
    seconds: Math.max(1, Number(minutes || 0) * 60 + Number(seconds || 0)),
  };
}

function saveTasks() {
  localStorage.setItem(storageKey, JSON.stringify(tasks));
}

function render() {
  els.taskList.innerHTML = "";
  els.taskCount.textContent = `${tasks.length}件`;
  els.emptyState.hidden = tasks.length > 0;

  tasks.forEach((task, index) => {
    const item = document.createElement("article");
    item.className = "task-item";
    item.draggable = true;
    item.dataset.id = task.id;
    if (index === activeIndex && mode !== "idle") item.classList.add("active");
    if (task.id === draggingTaskId) item.classList.add("dragging");

    const handle = document.createElement("button");
    handle.className = "drag-handle";
    handle.type = "button";
    handle.textContent = "≡";
    handle.title = "並び替え";
    handle.setAttribute("aria-label", "並び替え");
    handle.addEventListener("pointerdown", (event) => beginPointerDrag(event, task.id));

    const main = document.createElement("div");
    main.className = "task-main";

    const name = document.createElement("div");
    name.className = "task-name";
    name.textContent = task.name;

    const time = document.createElement("div");
    time.className = "task-time";
    time.textContent = formatDuration(task.seconds);

    main.append(name, time);

    const actions = document.createElement("div");
    actions.className = "task-actions";

    const edit = document.createElement("button");
    edit.className = "small-button";
    edit.type = "button";
    edit.textContent = "編集";
    edit.addEventListener("click", () => openEditDialog(task.id));

    const remove = document.createElement("button");
    remove.className = "small-button delete";
    remove.type = "button";
    remove.textContent = "削除";
    remove.addEventListener("click", () => deleteTask(task.id));

    actions.append(edit, remove);
    item.append(handle, main, actions);

    item.addEventListener("dragstart", (event) => {
      draggingTaskId = task.id;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", task.id);
      render();
    });

    item.addEventListener("dragover", (event) => {
      event.preventDefault();
      const fromId = event.dataTransfer.getData("text/plain") || draggingTaskId;
      if (fromId && fromId !== task.id) reorderTask(fromId, task.id);
    });

    item.addEventListener("dragend", () => {
      draggingTaskId = null;
      render();
    });

    els.taskList.append(item);
  });

  updateDisplay();
}

function updateDisplay() {
  const current = tasks[activeIndex];

  if (!current) {
    els.timerStatus.textContent = "待機中";
    els.currentTaskName.textContent = "タスクを追加してください";
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
    running: `${activeIndex + 1} / ${tasks.length}`,
    paused: "一時停止中",
    complete: "完了",
  };

  els.timerStatus.textContent = status[mode] || "待機中";
  els.currentTaskName.textContent = current.name;
  els.timeDisplay.textContent = formatClock(remainingSeconds || current.seconds);

  const base = totalSeconds || current.seconds;
  const done = base > 0 ? Math.max(0, Math.min(1, (base - remainingSeconds) / base)) : 0;
  els.progressFill.style.width = `${done * 100}%`;
}

function resetTimerState(index = 0) {
  stopTicker();
  activeIndex = Math.min(Math.max(index, 0), Math.max(tasks.length - 1, 0));
  const current = tasks[activeIndex];
  remainingSeconds = current?.seconds || 0;
  totalSeconds = current?.seconds || 0;
  mode = "idle";
  render();
}

function startOrPause() {
  ensureMediaReady();

  if (mode === "running") {
    pauseTimer();
    return;
  }

  if (!tasks.length) return;
  if (mode === "idle") {
    activeIndex = Math.min(activeIndex, tasks.length - 1);
    remainingSeconds = tasks[activeIndex].seconds;
    totalSeconds = tasks[activeIndex].seconds;
    speak(`最初は、${tasks[activeIndex].name}です`);
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
  updateDisplay();
}

function completeCurrentTask() {
  stopTicker();
  playAlarm();

  const nextIndex = activeIndex + 1;
  if (nextIndex >= tasks.length) {
    mode = "complete";
    speak("おつかれさまでした");
    updateDisplay();
    setTimeout(() => resetTimerState(0), 1200);
    return;
  }

  activeIndex = nextIndex;
  remainingSeconds = tasks[activeIndex].seconds;
  totalSeconds = tasks[activeIndex].seconds;
  speak(`次は、${tasks[activeIndex].name}です`);
  startTimer();
}

function skipToNext() {
  ensureMediaReady();
  if (mode === "idle" || !tasks.length) return;
  completeCurrentTask();
}

function stopTicker() {
  if (timerId) window.clearInterval(timerId);
  timerId = null;
}

function openAddDialog() {
  editingTaskId = null;
  els.dialogTitle.textContent = "タスクを追加";
  els.nameInput.value = "";
  els.minutesInput.value = "1";
  els.secondsInput.value = "0";
  els.formError.textContent = "";
  showDialog();
}

function openEditDialog(id) {
  const task = tasks.find((item) => item.id === id);
  if (!task) return;

  editingTaskId = id;
  els.dialogTitle.textContent = "タスクを編集";
  els.nameInput.value = task.name;
  els.minutesInput.value = String(Math.floor(task.seconds / 60));
  els.secondsInput.value = String(task.seconds % 60);
  els.formError.textContent = "";
  showDialog();
}

function showDialog() {
  if (typeof els.dialog.showModal === "function") {
    els.dialog.showModal();
  } else {
    els.dialog.setAttribute("open", "");
  }
  setTimeout(() => els.nameInput.focus(), 0);
}

function closeDialog() {
  if (typeof els.dialog.close === "function") {
    els.dialog.close();
  } else {
    els.dialog.removeAttribute("open");
  }
}

function submitTask(event) {
  event.preventDefault();
  const name = els.nameInput.value.trim();
  const minutes = clampInteger(els.minutesInput.value, 0, 999);
  const seconds = clampInteger(els.secondsInput.value, 0, 59);
  const total = minutes * 60 + seconds;

  if (!name) {
    els.formError.textContent = "やることを入力してください";
    return;
  }

  if (total <= 0) {
    els.formError.textContent = "時間は1秒以上にしてください";
    return;
  }

  if (editingTaskId) {
    const task = tasks.find((item) => item.id === editingTaskId);
    if (task) {
      task.name = name;
      task.seconds = total;
    }
  } else {
    tasks.push(makeTask(name, 0, total));
  }

  saveTasks();
  closeDialog();
  if (mode === "idle" || mode === "complete") resetTimerState(activeIndex);
  render();
}

function deleteTask(id) {
  const index = tasks.findIndex((task) => task.id === id);
  if (index < 0) return;

  const wasActive = index === activeIndex;
  tasks.splice(index, 1);
  if (activeIndex >= tasks.length) activeIndex = Math.max(0, tasks.length - 1);
  saveTasks();

  if (!tasks.length) {
    resetTimerState(0);
    return;
  }

  if (mode === "idle" || wasActive) resetTimerState(activeIndex);
  render();
}

function reorderTask(fromId, toId) {
  const fromIndex = tasks.findIndex((task) => task.id === fromId);
  const toIndex = tasks.findIndex((task) => task.id === toId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;

  const activeId = tasks[activeIndex]?.id;
  const [moved] = tasks.splice(fromIndex, 1);
  tasks.splice(toIndex, 0, moved);
  activeIndex = Math.max(0, tasks.findIndex((task) => task.id === activeId));
  saveTasks();
  render();
}

function beginPointerDrag(event, taskId) {
  event.preventDefault();
  pointerDrag = { taskId };
  draggingTaskId = taskId;
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
  if (targetId && targetId !== pointerDrag.taskId) reorderTask(pointerDrag.taskId, targetId);
}

function finishPointerDrag() {
  pointerDrag = null;
  draggingTaskId = null;
  document.removeEventListener("pointermove", movePointerDrag);
  document.removeEventListener("pointerup", finishPointerDrag);
  document.removeEventListener("pointercancel", finishPointerDrag);
  render();
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

els.addTask.addEventListener("click", openAddDialog);
els.startPause.addEventListener("click", startOrPause);
els.reset.addEventListener("click", () => resetTimerState(0));
els.next.addEventListener("click", skipToNext);
els.form.addEventListener("submit", submitTask);
els.closeDialog.addEventListener("click", closeDialog);
els.cancelDialog.addEventListener("click", closeDialog);
els.dialog.addEventListener("click", (event) => {
  if (event.target === els.dialog) closeDialog();
});
