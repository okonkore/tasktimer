const app = document.querySelector("#chatApp");
const apiOrigin = globalThis.location.origin;
let retryTimer = null;
let eventSource = null;
let activePageCleanup = null;
const seenEventIds = new Set();

function apiError(body, fallback) {
  return body && typeof body.error === "string" ? body.error : fallback;
}

function readCsrfToken() {
  const name = "__Host-tasktimer_chat_csrf=";
  const cookie = document.cookie.split(";").map((value) => value.trim()).find(
    (value) => value.startsWith(name),
  );
  return cookie ? cookie.slice(name.length) : null;
}

function safeReturnTo(value) {
  if (!value || typeof value !== "string") return null;
  try {
    const url = new URL(value, apiOrigin);
    if (url.origin !== apiOrigin) return null;
    if (url.pathname !== "/chat" && !url.pathname.startsWith("/chat/")) {
      return null;
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function currentReturnTo() {
  return safeReturnTo(
    `${globalThis.location.pathname}${globalThis.location.search}${globalThis.location.hash}`,
  ) ?? "/chat/";
}

function loginUrl(returnTo) {
  return `/chat/login?returnTo=${
    encodeURIComponent(safeReturnTo(returnTo) ?? "/chat/")
  }`;
}

function navigate(path) {
  globalThis.location.assign(path);
}

async function getCurrentUser() {
  const response = await fetch("/api/chat/me", {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (response.status === 401) return null;
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(apiError(body, "ログイン状態を確認できませんでした。"));
  }
  return body;
}

async function postJson(path, body, includeCsrf = false) {
  const headers = { "content-type": "application/json" };
  if (includeCsrf) {
    const csrfToken = readCsrfToken();
    if (csrfToken) headers["x-csrf-token"] = csrfToken;
  }
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers,
    body: JSON.stringify(body),
  });
  return { response, body: await response.json().catch(() => null) };
}

async function requestJson(path, method, body, includeCsrf = false) {
  const headers = { "content-type": "application/json" };
  if (includeCsrf) {
    const csrfToken = readCsrfToken();
    if (csrfToken) headers["x-csrf-token"] = csrfToken;
  }
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, body: await response.json().catch(() => null) };
}

function renderPanel(content) {
  clearActivePageSubscription();
  app.innerHTML = `
    <section class="chat-panel" aria-labelledby="chatTitle">
      <p class="eyebrow">Paradise Timer</p>
      ${content}
    </section>`;
}

function clearActivePageSubscription() {
  if (activePageCleanup) {
    activePageCleanup();
    activePageCleanup = null;
  }
}

function ensureRealtimeEvents() {
  if (eventSource || typeof EventSource !== "function") return;
  eventSource = new EventSource("/api/chat/events");
  for (
    const type of [
      "message-created",
      "message-deleted",
      "join-requested",
      "join-approved",
      "join-rejected",
      "permission-changed",
      "member-removed",
    ]
  ) {
    eventSource.addEventListener(type, (event) => handleRealtimeEvent(event));
  }
  eventSource.addEventListener("error", () => {
    // EventSource reconnects with the server-provided retry delay and resumes
    // with Last-Event-ID automatically. Keep the source alive for that path.
  });
}

function stopRealtimeEvents() {
  if (eventSource) eventSource.close();
  eventSource = null;
  seenEventIds.clear();
}

function handleRealtimeEvent(event) {
  if (event.lastEventId && seenEventIds.has(event.lastEventId)) return;
  if (event.lastEventId) {
    seenEventIds.add(event.lastEventId);
    if (seenEventIds.size > 256) {
      seenEventIds.delete(seenEventIds.values().next().value);
    }
  }
  let payload;
  try {
    payload = JSON.parse(event.data);
  } catch {
    return;
  }
  if (
    !payload || typeof payload.type !== "string" ||
    typeof payload.roomId !== "string"
  ) return;
  showRealtimeNotification(payload.type);
  void refreshDashboardBadges();
  globalThis.dispatchEvent(
    new CustomEvent("chat-realtime", { detail: payload }),
  );

  const currentRoom = globalThis.location.pathname.match(
    /^\/chat\/rooms\/([A-Za-z0-9_-]{16,64})$/,
  );
  if (
    currentRoom && currentRoom[1] === payload.roomId &&
    ["join-approved", "join-rejected", "permission-changed", "member-removed"]
      .includes(payload.type)
  ) {
    void renderRoomPage(payload.roomId);
  }
}

function showRealtimeNotification(type) {
  const messages = {
    "join-requested": "ルームに新しい参加申請が届きました。",
    "join-approved": "参加申請が承認されました。",
    "join-rejected": "参加申請が拒否されました。",
    "permission-changed": "ルームでの権限が変更されました。",
    "member-removed": "ルームへの参加が解除されました。",
  };
  if (!messages[type]) return;
  let container = document.querySelector("#chatNotifications");
  if (!container) {
    container = document.createElement("div");
    container.id = "chatNotifications";
    container.className = "chat-notifications";
    container.setAttribute("aria-live", "polite");
    document.body.append(container);
  }
  const notice = document.createElement("p");
  notice.className = "chat-notification";
  notice.textContent = messages[type];
  container.append(notice);
  globalThis.setTimeout(() => notice.remove(), 8_000);
}

function renderNotice(title, message, actions = "") {
  clearRetryTimer();
  renderPanel(`
    <h1 id="chatTitle">${title}</h1>
    <p class="lead" data-message></p>
    <div class="actions">${actions}</div>`);
  app.querySelector("[data-message]").textContent = message;
}

function clearRetryTimer() {
  if (retryTimer !== null) {
    globalThis.clearInterval(retryTimer);
    retryTimer = null;
  }
}

function errorText(error) {
  return error instanceof Error
    ? error.message
    : "通信に失敗しました。もう一度お試しください。";
}

function renderLoginEmail(state) {
  clearRetryTimer();
  renderPanel(`
    <h1 id="chatTitle">チャットにログイン</h1>
    <p class="lead">メールアドレスに届く6桁のログインコードを使います。</p>
    <form class="stack" data-email-form novalidate>
      <label for="email">メールアドレス</label>
      <input id="email" name="email" type="email" inputmode="email" autocomplete="email" required maxlength="254" />
      <p class="form-error" data-error role="alert" hidden></p>
      <button type="submit">ログインコードを送信</button>
    </form>
    <p class="privacy-note">メールアドレスはログインにだけ使用し、他のユーザーには公開しません。</p>
    <a class="back-link" href="/">タイマーへ戻る</a>`);

  const form = app.querySelector("[data-email-form]");
  const emailInput = form.elements.email;
  const error = form.querySelector("[data-error]");
  const button = form.querySelector("button");
  emailInput.value = state.email;
  if (state.error) {
    error.textContent = state.error;
    error.hidden = false;
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = emailInput.value.trim();
    if (!email || !emailInput.checkValidity()) {
      error.textContent = "有効なメールアドレスを入力してください。";
      error.hidden = false;
      return;
    }
    error.hidden = true;
    button.disabled = true;
    button.textContent = "送信中…";
    try {
      const result = await postJson("/api/chat/auth/request-otp", { email });
      if (result.response.status === 202) {
        renderLoginCode({
          email,
          returnTo: state.returnTo,
          retryAt: Date.now() + 60_000,
        });
        return;
      }
      renderLoginEmail({
        ...state,
        email,
        error: apiError(result.body, "ログインコードを送信できませんでした。"),
      });
    } catch (requestError) {
      renderLoginEmail({ ...state, email, error: errorText(requestError) });
    }
  });
}

function renderLoginCode(state) {
  clearRetryTimer();
  renderPanel(`
    <h1 id="chatTitle">ログインコードを入力</h1>
    <p class="lead">メールアドレスに送った6桁のコードを入力してください。</p>
    <p class="email-confirmation" data-email></p>
    <form class="stack" data-code-form novalidate>
      <label for="otp">ログインコード</label>
      <input id="otp" name="otp" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required />
      <p class="form-error" data-error role="alert" hidden></p>
      <button type="submit">ログイン</button>
    </form>
    <div class="resend-row">
      <button class="secondary" type="button" data-resend disabled>コードを再送</button>
      <span data-countdown aria-live="polite"></span>
    </div>
    <button class="text-button" type="button" data-change-email>メールアドレスを変更</button>`);

  const form = app.querySelector("[data-code-form]");
  const codeInput = form.elements.otp;
  const error = form.querySelector("[data-error]");
  const submitButton = form.querySelector("button");
  const resendButton = app.querySelector("[data-resend]");
  const countdown = app.querySelector("[data-countdown]");
  app.querySelector("[data-email]").textContent = state.email;

  const updateCountdown = () => {
    const seconds = Math.max(0, Math.ceil((state.retryAt - Date.now()) / 1000));
    if (seconds === 0) {
      resendButton.disabled = false;
      countdown.textContent = "再送できます";
      clearRetryTimer();
      return;
    }
    resendButton.disabled = true;
    countdown.textContent = `再送まで ${seconds} 秒`;
  };
  updateCountdown();
  if (resendButton.disabled) {
    retryTimer = globalThis.setInterval(updateCountdown, 250);
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = codeInput.value.trim();
    if (!/^\d{6}$/.test(code)) {
      error.textContent = "6桁の数字を入力してください。";
      error.hidden = false;
      return;
    }
    error.hidden = true;
    submitButton.disabled = true;
    submitButton.textContent = "確認中…";
    try {
      const result = await postJson("/api/chat/auth/verify-otp", {
        email: state.email,
        code,
      });
      if (result.response.ok) {
        const destination = safeReturnTo(state.returnTo) ?? "/chat/";
        if (result.body && result.body.needsProfile) {
          navigate(
            `/chat/profile?setup=1&returnTo=${encodeURIComponent(destination)}`,
          );
        } else {
          navigate(destination);
        }
        return;
      }
      renderLoginCode({
        ...state,
        error: apiError(result.body, "ログインコードを確認できませんでした。"),
      });
    } catch (requestError) {
      renderLoginCode({ ...state, error: errorText(requestError) });
    }
  });

  resendButton.addEventListener("click", async () => {
    resendButton.disabled = true;
    countdown.textContent = "送信中…";
    try {
      const result = await postJson("/api/chat/auth/request-otp", {
        email: state.email,
      });
      if (result.response.status === 202) {
        renderLoginCode({ ...state, retryAt: Date.now() + 60_000 });
        return;
      }
      renderLoginCode({
        ...state,
        error: apiError(result.body, "ログインコードを再送できませんでした。"),
      });
    } catch (requestError) {
      renderLoginCode({ ...state, error: errorText(requestError) });
    }
  });
  app.querySelector("[data-change-email]").addEventListener("click", () => {
    renderLoginEmail({ returnTo: state.returnTo, email: state.email });
  });
  if (state.error) {
    error.textContent = state.error;
    error.hidden = false;
  }
}

async function renderProfile() {
  clearRetryTimer();
  renderNotice("プロフィール", "プロフィールを読み込んでいます。");
  try {
    const current = await getCurrentUser();
    if (!current) {
      navigate(loginUrl(currentReturnTo()));
      return;
    }
    const parameters = new URLSearchParams(globalThis.location.search);
    const firstSetup = parameters.get("setup") === "1" || current.needsProfile;
    const returnTo = safeReturnTo(parameters.get("returnTo")) ?? "/chat/";
    renderPanel(`
      <h1 id="chatTitle">${firstSetup ? "表示名を設定" : "プロフィール"}</h1>
      <p class="lead">${
      firstSetup
        ? "チャットで使う表示名を設定してください。"
        : "チャットで表示する名前を変更できます。"
    }</p>
      <form class="stack" data-profile-form novalidate>
        <label for="displayName">表示名</label>
        <input id="displayName" name="displayName" type="text" autocomplete="nickname" required minlength="1" maxlength="30" />
        <p class="field-hint">1〜30文字。ほかのユーザーにはメールアドレスを表示しません。</p>
        <label class="checkbox-row" for="emailNotificationsEnabled">
          <input id="emailNotificationsEnabled" name="emailNotificationsEnabled" type="checkbox" />
          参加申請をメールで受け取る
        </label>
        <p class="field-hint">自分がオーナーのルームへの参加申請をメールで通知します。</p>
        <p class="form-error" data-error role="alert" hidden></p>
        <p class="form-success" data-success role="status" hidden></p>
        <button type="submit">${
      firstSetup ? "表示名を保存して続ける" : "表示名を保存"
    }</button>
      </form>
      ${
      firstSetup ? "" : '<a class="back-link" href="/chat/">チャットへ戻る</a>'
    }`);
    const form = app.querySelector("[data-profile-form]");
    const input = form.elements.displayName;
    const emailNotificationsInput = form.elements.emailNotificationsEnabled;
    const error = form.querySelector("[data-error]");
    const success = form.querySelector("[data-success]");
    const button = form.querySelector("button");
    input.value = current.user.displayName ?? "";
    emailNotificationsInput.checked = current.user.emailNotificationsEnabled !==
      false;
    input.focus();
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const displayName = input.value.trim();
      if (!displayName || displayName.length > 30) {
        error.textContent = "表示名は空白を除いて1〜30文字で入力してください。";
        error.hidden = false;
        return;
      }
      error.hidden = true;
      success.hidden = true;
      button.disabled = true;
      button.textContent = "保存中…";
      try {
        const csrfToken = readCsrfToken();
        const response = await fetch("/api/chat/me", {
          method: "PATCH",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
            ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
          },
          body: JSON.stringify({
            displayName,
            emailNotificationsEnabled: emailNotificationsInput.checked,
          }),
        });
        const body = await response.json().catch(() => null);
        if (response.status === 401) {
          navigate(loginUrl(currentReturnTo()));
          return;
        }
        if (!response.ok) {
          throw new Error(apiError(body, "表示名を保存できませんでした。"));
        }
        if (firstSetup) {
          navigate(returnTo);
          return;
        }
        input.value = body.user.displayName;
        success.textContent = "表示名を保存しました。";
        success.hidden = false;
        button.disabled = false;
        button.textContent = "表示名を保存";
      } catch (requestError) {
        error.textContent = errorText(requestError);
        error.hidden = false;
        button.disabled = false;
        button.textContent = firstSetup
          ? "表示名を保存して続ける"
          : "表示名を保存";
      }
    });
  } catch (requestError) {
    renderNotice(
      "プロフィール",
      errorText(requestError),
      `<a href="/chat/">チャットへ戻る</a>`,
    );
  }
}

async function renderChatHome() {
  clearRetryTimer();
  renderNotice("チャット", "ログイン状態を確認しています。");
  try {
    const current = await getCurrentUser();
    if (!current) {
      renderNotice(
        "チャット",
        "ルームの作成・参加にはログインが必要です。",
        `<a class="button-link" href="${
          loginUrl("/chat/")
        }">ログイン</a><a class="back-link" href="/">タイマーへ戻る</a>`,
      );
      return;
    }
    if (current.needsProfile) {
      navigate("/chat/profile?setup=1&returnTo=%2Fchat%2F");
      return;
    }
    ensureRealtimeEvents();
    await renderDashboard();
  } catch (requestError) {
    renderNotice(
      "チャット",
      errorText(requestError),
      `<a href="${loginUrl("/chat/")}">ログイン</a>`,
    );
  }
}

async function requireChatUser() {
  const current = await getCurrentUser();
  if (!current) {
    navigate(loginUrl(currentReturnTo()));
    return null;
  }
  if (current.needsProfile) {
    navigate(
      `/chat/profile?setup=1&returnTo=${encodeURIComponent(currentReturnTo())}`,
    );
    return null;
  }
  ensureRealtimeEvents();
  return current;
}

function addDashboardActions() {
  const logout = app.querySelector("[data-logout]");
  logout.addEventListener("click", async () => {
    logout.disabled = true;
    try {
      const result = await postJson("/api/chat/auth/logout", {}, true);
      if (!result.response.ok) {
        throw new Error(apiError(result.body, "ログアウトできませんでした。"));
      }
      stopRealtimeEvents();
      navigate("/chat/");
    } catch (requestError) {
      logout.disabled = false;
      globalThis.alert(errorText(requestError));
    }
  });
}

async function renderDashboard() {
  renderPanel(`
    <div class="panel-heading">
      <div><p class="eyebrow">Paradise Timer</p><h1 id="chatTitle">チャット</h1></div>
      <a class="secondary-link" href="/chat/profile">プロフィール</a>
    </div>
    <div class="dashboard-actions">
      <a class="button-link" href="/chat/rooms/new">ルームを作成</a>
      <button class="text-button" type="button" data-logout>ログアウト</button>
    </div>
    <section class="room-section" aria-labelledby="ownedRoomsTitle">
      <h2 id="ownedRoomsTitle">所有ルーム</h2><div data-owned-rooms class="room-list"></div>
    </section>
    <section class="room-section" aria-labelledby="joinedRoomsTitle">
      <h2 id="joinedRoomsTitle">参加ルーム</h2><div data-joined-rooms class="room-list"></div>
    </section>
    <a class="back-link" href="/">タイマーへ戻る</a>`);
  addDashboardActions();
  try {
    const result = await requestJson("/api/chat/rooms", "GET");
    if (result.response.status === 401) {
      navigate(loginUrl("/chat/"));
      return;
    }
    if (!result.response.ok) {
      throw new Error(apiError(result.body, "ルームを読み込めませんでした。"));
    }
    renderRoomList(
      app.querySelector("[data-owned-rooms]"),
      result.body.ownedRooms,
      "所有しているルームはありません。",
    );
    renderRoomList(
      app.querySelector("[data-joined-rooms]"),
      result.body.joinedRooms,
      "参加しているルームはありません。",
    );
    await refreshDashboardBadges();
  } catch (requestError) {
    renderNotice(
      "チャット",
      errorText(requestError),
      '<a class="back-link" href="/">タイマーへ戻る</a>',
    );
  }
}

function renderRoomList(container, rooms, emptyMessage) {
  container.replaceChildren();
  if (!Array.isArray(rooms) || rooms.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-rooms";
    empty.textContent = emptyMessage;
    container.append(empty);
    return;
  }
  for (const room of rooms) {
    if (!room || typeof room.id !== "string" || typeof room.name !== "string") {
      continue;
    }
    const link = document.createElement("a");
    link.className = "room-card";
    link.href = `/chat/rooms/${encodeURIComponent(room.id)}`;
    const name = document.createElement("strong");
    name.textContent = room.name;
    const description = document.createElement("span");
    description.textContent =
      typeof room.description === "string" && room.description
        ? room.description
        : "説明はありません";
    const role = document.createElement("small");
    role.textContent = room.role === "owner"
      ? "オーナー"
      : room.role === "writer"
      ? "書き込み可"
      : "閲覧のみ";
    const badges = document.createElement("span");
    badges.className = "room-badges";
    badges.dataset.roomBadges = room.id;
    link.dataset.roomId = room.id;
    link.append(name, description, role, badges);
    container.append(link);
  }
}

async function refreshDashboardBadges() {
  const roomCards = app.querySelectorAll("[data-room-id]");
  if (roomCards.length === 0) return;
  try {
    const result = await requestJson("/api/chat/notifications", "GET");
    if (!result.response.ok || !Array.isArray(result.body?.rooms)) return;
    const summaries = new Map(
      result.body.rooms.filter((room) =>
        room && typeof room.roomId === "string"
      ).map((room) => [room.roomId, room]),
    );
    for (const card of roomCards) {
      const badges = card.querySelector("[data-room-badges]");
      const summary = summaries.get(card.dataset.roomId);
      if (!badges || !summary) continue;
      badges.replaceChildren();
      addRoomBadge(badges, summary.unreadCount, "未読");
      addRoomBadge(badges, summary.pendingRequestCount, "申請");
    }
  } catch {
    // The dashboard itself remains usable if a background badge refresh fails.
  }
}

function addRoomBadge(container, value, label) {
  if (!Number.isInteger(value) || value < 1) return;
  const badge = document.createElement("span");
  badge.className = "room-badge";
  badge.textContent = `${label} ${value > 99 ? "99+" : value}`;
  container.append(badge);
}

async function renderRoomCreate() {
  clearRetryTimer();
  try {
    if (!await requireChatUser()) return;
    renderPanel(`
      <p class="eyebrow">チャット</p><h1 id="chatTitle">ルームを作成</h1>
      <p class="lead">共有URLを使って、ほかのユーザーが参加申請できるルームを作成します。</p>
      <form class="stack" data-room-form novalidate>
        <label for="roomName">ルーム名</label>
        <input id="roomName" name="roomName" type="text" required maxlength="50" autocomplete="off" />
        <label for="roomDescription">説明 <span class="optional">任意</span></label>
        <textarea id="roomDescription" name="roomDescription" maxlength="200" rows="4"></textarea>
        <p class="field-hint">ルーム名は1〜50文字、説明は200文字までです。</p>
        <p class="form-error" data-error role="alert" hidden></p>
        <button type="submit">ルームを作成</button>
      </form>
      <a class="back-link" href="/chat/">チャットへ戻る</a>`);
    const form = app.querySelector("[data-room-form]");
    const error = form.querySelector("[data-error]");
    const button = form.querySelector("button");
    form.elements.roomName.focus();
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = form.elements.roomName.value.trim();
      const description = form.elements.roomDescription.value.trim();
      if (!name || name.length > 50 || description.length > 200) {
        error.textContent =
          "ルーム名は1〜50文字、説明は200文字までで入力してください。";
        error.hidden = false;
        return;
      }
      button.disabled = true;
      button.textContent = "作成中…";
      try {
        const result = await requestJson("/api/chat/rooms", "POST", {
          name,
          description,
        }, true);
        if (result.response.status === 401) {
          navigate(loginUrl(currentReturnTo()));
          return;
        }
        if (!result.response.ok) {
          throw new Error(
            apiError(result.body, "ルームを作成できませんでした。"),
          );
        }
        navigate(`/chat/rooms/${encodeURIComponent(result.body.room.id)}`);
      } catch (requestError) {
        error.textContent = errorText(requestError);
        error.hidden = false;
        button.disabled = false;
        button.textContent = "ルームを作成";
      }
    });
  } catch (requestError) {
    renderNotice(
      "ルームを作成",
      errorText(requestError),
      '<a class="back-link" href="/chat/">チャットへ戻る</a>',
    );
  }
}

async function loadRoom(roomId) {
  const result = await requestJson(
    `/api/chat/rooms/${encodeURIComponent(roomId)}`,
    "GET",
  );
  if (result.response.status === 401) {
    navigate(loginUrl(currentReturnTo()));
    return null;
  }
  if (result.response.status === 403 && result.body?.access) {
    return result.body;
  }
  if (!result.response.ok) {
    throw new Error(apiError(result.body, "ルームを読み込めませんでした。"));
  }
  return result.body;
}

async function renderRoomPage(roomId) {
  clearRetryTimer();
  try {
    const currentUser = await requireChatUser();
    if (!currentUser) return;
    const result = await loadRoom(roomId);
    if (!result) return;
    if (result.access) {
      renderJoinAccess(roomId, result.access);
      return;
    }
    renderPanel(`
      <p class="eyebrow">チャットルーム</p><h1 id="chatTitle" data-room-name></h1>
      <p class="lead room-description" data-room-description></p>
      <div class="actions" data-room-actions></div>
      <section class="chat-thread" aria-label="メッセージ">
        <div class="message-scroll" data-message-scroll tabindex="0">
          <div class="history-control" data-history-control></div>
          <p class="form-error" data-history-error role="alert" hidden></p>
          <div class="message-list" data-message-list aria-live="polite" aria-relevant="additions text"></div>
        </div>
      </section>
      <p class="form-error" data-message-error role="alert" hidden></p>
      <div data-message-composer></div>
      <details class="share-details">
        <summary>共有URL</summary>
        <div class="share-box"><label for="shareUrl">共有URL</label><input id="shareUrl" type="text" readonly /></div>
      </details>
      <a class="back-link" href="/chat/">ルーム一覧へ戻る</a>`);
    app.querySelector("[data-room-name]").textContent = result.room.name;
    app.querySelector("[data-room-description]").textContent =
      result.room.description || "説明はありません。";
    app.querySelector("#shareUrl").value =
      `${apiOrigin}/chat/rooms/${result.room.id}`;
    const actions = app.querySelector("[data-room-actions]");
    if (result.isOwner) {
      const settings = document.createElement("a");
      settings.className = "button-link";
      settings.href = `/chat/rooms/${encodeURIComponent(roomId)}/settings`;
      settings.textContent = "ルーム設定";
      actions.append(settings);
    }
    const members = document.createElement("a");
    members.className = result.isOwner
      ? "secondary button-link"
      : "button-link";
    members.href = `/chat/rooms/${encodeURIComponent(roomId)}/members`;
    members.textContent = result.isOwner
      ? "参加申請・メンバー管理"
      : "メンバー";
    actions.append(members);
    const messageState = {
      roomId,
      currentUserId: currentUser.user.id,
      isOwner: result.isOwner === true,
      role: result.membership.role,
      messages: [],
      nextBefore: null,
      loadingOlder: false,
    };
    renderMessageHistory(messageState);
    renderMessageComposer(messageState);
    await loadInitialMessages(messageState);
    const onRealtimeEvent = (event) => {
      const realtime = event.detail;
      if (realtime?.roomId !== roomId) return;
      if (
        realtime.type === "message-created" ||
        realtime.type === "message-deleted"
      ) {
        void refreshLatestMessages(messageState);
      }
    };
    globalThis.addEventListener("chat-realtime", onRealtimeEvent);
    activePageCleanup = () =>
      globalThis.removeEventListener("chat-realtime", onRealtimeEvent);
  } catch (requestError) {
    renderNotice(
      "ルーム",
      errorText(requestError),
      '<a class="back-link" href="/chat/">ルーム一覧へ戻る</a>',
    );
  }
}

function messagePath(roomId) {
  return `/api/chat/rooms/${encodeURIComponent(roomId)}/messages`;
}

function readPositionPath(roomId) {
  return `/api/chat/rooms/${encodeURIComponent(roomId)}/read-position`;
}

async function markRoomRead(state) {
  const lastMessage = state.messages.at(-1);
  if (!lastMessage?.id) return;
  try {
    await requestJson(readPositionPath(state.roomId), "POST", {
      messageId: lastMessage.id,
    }, true);
  } catch {
    // A later read, refresh, or reconnect retries this non-destructive update.
  }
}

async function refreshLatestMessages(state) {
  const scroll = app.querySelector("[data-message-scroll]");
  const nearBottom =
    scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 48;
  try {
    const result = await requestJson(messagePath(state.roomId), "GET");
    if (result.response.status === 401) {
      navigate(loginUrl(currentReturnTo()));
      return;
    }
    if (result.response.status === 403) {
      await renderRoomPage(state.roomId);
      return;
    }
    if (!result.response.ok || !isMessagePage(result.body)) return;
    state.messages = mergeMessages(
      state.messages,
      validMessages(result.body.messages),
    );
    state.nextBefore = state.nextBefore ?? result.body.nextBefore;
    renderMessageHistory(state);
    if (nearBottom) {
      scroll.scrollTop = scroll.scrollHeight;
      await markRoomRead(state);
    }
  } catch {
    // SSE is advisory; normal history loading remains available after a retry.
  }
}

function isMessagePage(value) {
  return value && Array.isArray(value.messages) &&
    (typeof value.nextBefore === "string" || value.nextBefore === null);
}

function validMessages(messages) {
  return messages.filter((message) =>
    message && typeof message.id === "string" &&
    typeof message.authorId === "string" &&
    typeof message.createdAt === "string" &&
    (typeof message.body === "string" || message.body === null)
  );
}

function mergeMessages(existing, additions) {
  const messagesById = new Map(
    existing.map((message) => [message.id, message]),
  );
  for (const message of additions) messagesById.set(message.id, message);
  return [...messagesById.values()].sort((left, right) => {
    const time = left.createdAt.localeCompare(right.createdAt);
    return time === 0 ? left.id.localeCompare(right.id) : time;
  });
}

async function loadInitialMessages(state) {
  const list = app.querySelector("[data-message-list]");
  list.textContent = "メッセージを読み込んでいます…";
  const result = await requestJson(messagePath(state.roomId), "GET");
  if (result.response.status === 401) {
    navigate(loginUrl(currentReturnTo()));
    return;
  }
  if (result.response.status === 403) {
    await renderRoomPage(state.roomId);
    return;
  }
  if (!result.response.ok || !isMessagePage(result.body)) {
    throw new Error(
      apiError(result.body, "メッセージを読み込めませんでした。"),
    );
  }
  state.messages = mergeMessages([], validMessages(result.body.messages));
  state.nextBefore = result.body.nextBefore;
  renderMessageHistory(state);
  const scroll = app.querySelector("[data-message-scroll]");
  scroll.scrollTop = scroll.scrollHeight;
  await markRoomRead(state);
}

function renderMessageHistory(state) {
  const list = app.querySelector("[data-message-list]");
  const historyControl = app.querySelector("[data-history-control]");
  const historyError = app.querySelector("[data-history-error]");
  list.replaceChildren();
  historyControl.replaceChildren();
  historyError.hidden = true;
  if (state.nextBefore) {
    const older = document.createElement("button");
    older.type = "button";
    older.className = "secondary history-button";
    older.textContent = state.loadingOlder
      ? "読み込み中…"
      : "過去のメッセージを読み込む";
    older.disabled = state.loadingOlder;
    older.addEventListener("click", () => void loadOlderMessages(state));
    historyControl.append(older);
  } else if (state.messages.length > 0) {
    const end = document.createElement("p");
    end.className = "history-end";
    end.textContent = "これより前のメッセージはありません。";
    historyControl.append(end);
  }
  if (state.messages.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-messages";
    empty.textContent = "まだメッセージはありません。";
    list.append(empty);
    return;
  }
  for (const message of state.messages) {
    list.append(createMessageCard(message, state));
  }
}

async function loadOlderMessages(state) {
  if (!state.nextBefore || state.loadingOlder) return;
  const scroll = app.querySelector("[data-message-scroll]");
  const previousTop = scroll.scrollTop;
  const previousHeight = scroll.scrollHeight;
  state.loadingOlder = true;
  renderMessageHistory(state);
  try {
    const result = await requestJson(
      `${messagePath(state.roomId)}?before=${
        encodeURIComponent(state.nextBefore)
      }`,
      "GET",
    );
    if (result.response.status === 401) {
      navigate(loginUrl(currentReturnTo()));
      return;
    }
    if (result.response.status === 403) {
      await renderRoomPage(state.roomId);
      return;
    }
    if (!result.response.ok || !isMessagePage(result.body)) {
      throw new Error(
        apiError(result.body, "過去のメッセージを読み込めませんでした。"),
      );
    }
    state.messages = mergeMessages(
      state.messages,
      validMessages(result.body.messages),
    );
    state.nextBefore = result.body.nextBefore;
    state.loadingOlder = false;
    renderMessageHistory(state);
    scroll.scrollTop = previousTop + (scroll.scrollHeight - previousHeight);
  } catch (requestError) {
    state.loadingOlder = false;
    renderMessageHistory(state);
    const historyError = app.querySelector("[data-history-error]");
    historyError.textContent = errorText(requestError);
    historyError.hidden = false;
  }
}

function messageDateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "日時不明"
    : date.toLocaleString("ja-JP");
}

function createMessageCard(message, state) {
  const card = document.createElement("article");
  card.className = "message-card";
  if (message.authorId === state.currentUserId) {
    card.classList.add("own-message");
  }
  if (message.body === null) card.classList.add("redacted-message");
  const header = document.createElement("div");
  header.className = "message-meta";
  const author = document.createElement("strong");
  author.textContent = message.authorDisplayName || "退会したユーザー";
  const time = document.createElement("time");
  time.dateTime = message.createdAt;
  time.textContent = messageDateLabel(message.createdAt);
  header.append(author, time);
  const body = document.createElement("p");
  body.className = "message-body";
  body.textContent = message.body === null
    ? "削除されたメッセージ"
    : message.body;
  card.append(header, body);
  if (canDeleteMessage(message, state)) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "text-button message-delete";
    remove.textContent = "削除";
    remove.addEventListener(
      "click",
      () => void deleteMessage(message, state, remove),
    );
    card.append(remove);
  }
  return card;
}

function canDeleteMessage(message, state) {
  if (message.body === null) return false;
  return state.isOwner ||
    (state.role === "writer" && message.authorId === state.currentUserId);
}

async function deleteMessage(message, state, button) {
  if (!confirm("このメッセージを削除しますか？ 削除後は元に戻せません。")) {
    return;
  }
  const pageError = app.querySelector("[data-message-error]");
  pageError.hidden = true;
  button.disabled = true;
  button.textContent = "削除中…";
  try {
    const result = await requestJson(
      `${messagePath(state.roomId)}/${encodeURIComponent(message.id)}`,
      "DELETE",
      undefined,
      true,
    );
    if (result.response.status === 401) {
      navigate(loginUrl(currentReturnTo()));
      return;
    }
    if (result.response.status === 403) {
      await renderRoomPage(state.roomId);
      return;
    }
    if (!result.response.ok || !result.body?.message) {
      throw new Error(
        apiError(result.body, "メッセージを削除できませんでした。"),
      );
    }
    const redacted = {
      ...result.body.message,
      authorDisplayName: result.body.message.authorDisplayName ??
        message.authorDisplayName,
    };
    state.messages = mergeMessages(
      state.messages.filter((item) => item.id !== message.id),
      validMessages([redacted]),
    );
    renderMessageHistory(state);
  } catch (requestError) {
    pageError.textContent = errorText(requestError);
    pageError.hidden = false;
    button.disabled = false;
    button.textContent = "削除";
  }
}

function renderMessageComposer(state) {
  const container = app.querySelector("[data-message-composer]");
  container.replaceChildren();
  if (state.role !== "owner" && state.role !== "writer") {
    const viewerNotice = document.createElement("p");
    viewerNotice.className = "field-hint viewer-notice";
    viewerNotice.textContent =
      "あなたの権限は閲覧のみです。メッセージは投稿できません。";
    container.append(viewerNotice);
    return;
  }
  const form = document.createElement("form");
  form.className = "message-composer";
  form.noValidate = true;
  const label = document.createElement("label");
  label.htmlFor = "messageBody";
  label.textContent = "メッセージ";
  const textarea = document.createElement("textarea");
  textarea.id = "messageBody";
  textarea.name = "body";
  textarea.rows = 3;
  textarea.maxLength = 2000;
  textarea.required = true;
  textarea.placeholder = "メッセージを入力";
  textarea.setAttribute("aria-describedby", "messageHint messageComposeError");
  const hint = document.createElement("p");
  hint.id = "messageHint";
  hint.className = "field-hint";
  hint.textContent = "Enterで送信、Shift+Enterで改行します。最大2,000文字。";
  const error = document.createElement("p");
  error.id = "messageComposeError";
  error.className = "form-error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  const send = document.createElement("button");
  send.type = "submit";
  send.textContent = "送信";
  form.append(label, textarea, hint, error, send);
  container.append(form);
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitMessage(state, textarea, send, error);
  });
}

async function submitMessage(state, textarea, send, error) {
  const body = textarea.value;
  if (!body.trim() || Array.from(body).length > 2000) {
    error.textContent =
      "空白だけでない1〜2,000文字のメッセージを入力してください。";
    error.hidden = false;
    return;
  }
  error.hidden = true;
  send.disabled = textarea.disabled = true;
  send.textContent = "送信中…";
  try {
    const result = await requestJson(messagePath(state.roomId), "POST", {
      body,
    }, true);
    if (result.response.status === 401) {
      navigate(loginUrl(currentReturnTo()));
      return;
    }
    if (result.response.status === 403) {
      await renderRoomPage(state.roomId);
      return;
    }
    if (result.response.status !== 201 || !result.body?.message) {
      throw new Error(
        apiError(result.body, "メッセージを送信できませんでした。"),
      );
    }
    state.messages = mergeMessages(
      state.messages,
      validMessages([result.body.message]),
    );
    await markRoomRead(state);
    textarea.value = "";
    renderMessageHistory(state);
    const scroll = app.querySelector("[data-message-scroll]");
    scroll.scrollTop = scroll.scrollHeight;
    send.disabled = textarea.disabled = false;
    send.textContent = "送信";
    textarea.focus();
  } catch (requestError) {
    error.textContent = `${
      errorText(requestError)
    } 入力内容は残っています。再送してください。`;
    error.hidden = false;
    send.disabled = textarea.disabled = false;
    send.textContent = "再送";
  }
}

function formatRetryAt(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "24時間後"
    : date.toLocaleString("ja-JP");
}

function renderJoinAccess(roomId, access) {
  const canRequest = access?.canRequest === true;
  const status = access?.status;
  let title = "このルームに参加";
  let message =
    "参加にはオーナーの承認が必要です。参加申請を送信してください。";
  if (status === "pending") {
    title = "承認待ちです";
    message = "参加申請を送信しました。オーナーの承認をお待ちください。";
  } else if (status === "rejected" && !canRequest) {
    title = "参加申請は拒否されました";
    message = `再申請は ${
      formatRetryAt(access.rejectedUntil)
    } 以降にできます。`;
  } else if (status === "rejected") {
    title = "再申請できます";
    message = "もう一度参加申請を送信できます。";
  } else if (status === "removed") {
    title = "このルームへの参加が解除されています";
    message = "再度参加するには、新しい参加申請を送信してください。";
  }
  renderPanel(`
    <p class="eyebrow">チャットルーム</p><h1 id="chatTitle"></h1>
    <p class="lead" data-join-message></p>
    <p class="form-error" data-error role="alert" hidden></p>
    <div class="actions" data-join-actions></div>
    <a class="back-link" href="/chat/">ルーム一覧へ戻る</a>`);
  app.querySelector("#chatTitle").textContent = title;
  app.querySelector("[data-join-message]").textContent = message;
  const actions = app.querySelector("[data-join-actions]");
  if (canRequest) {
    const apply = document.createElement("button");
    apply.type = "button";
    apply.textContent = "参加申請を送信";
    actions.append(apply);
    apply.addEventListener("click", async () => {
      apply.disabled = true;
      apply.textContent = "送信中…";
      try {
        const submitted = await requestJson(
          `/api/chat/rooms/${encodeURIComponent(roomId)}/requests`,
          "POST",
          {},
          true,
        );
        if (!submitted.response.ok) {
          throw new Error(
            apiError(submitted.body, "参加申請を送信できませんでした。"),
          );
        }
        await renderRoomPage(roomId);
      } catch (requestError) {
        const error = app.querySelector("[data-error]");
        error.textContent = errorText(requestError);
        error.hidden = false;
        apply.disabled = false;
        apply.textContent = "参加申請を送信";
      }
    });
  }
  if (status === "pending") {
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "secondary";
    refresh.textContent = "承認状況を更新";
    refresh.addEventListener("click", () => void renderRoomPage(roomId));
    actions.append(refresh);
  }
}

function roleLabel(role) {
  return role === "owner"
    ? "オーナー"
    : role === "writer"
    ? "書き込み可"
    : "閲覧のみ";
}

async function renderMembersPage(roomId) {
  clearRetryTimer();
  try {
    if (!await requireChatUser()) return;
    const roomResult = await loadRoom(roomId);
    if (!roomResult) return;
    if (roomResult.access) {
      navigate(`/chat/rooms/${encodeURIComponent(roomId)}`);
      return;
    }
    renderPanel(`
      <p class="eyebrow">チャットルーム</p><h1 id="chatTitle">メンバー</h1>
      <p class="lead" data-members-room></p>
      <p class="form-error" data-page-error role="alert" hidden></p>
      <section class="room-section" aria-labelledby="membersTitle">
        <h2 id="membersTitle">参加メンバー</h2><div class="member-list" data-members></div>
      </section>
      ${
      roomResult.isOwner
        ? `<section class="room-section" aria-labelledby="requestsTitle"><h2 id="requestsTitle">参加申請</h2><div class="request-list" data-requests></div></section>`
        : ""
    }
      <a class="back-link" href="/chat/rooms/${
      encodeURIComponent(roomId)
    }">ルームへ戻る</a>`);
    app.querySelector("[data-members-room]").textContent = roomResult.room.name;
    const membersResult = await requestJson(
      `/api/chat/rooms/${encodeURIComponent(roomId)}/members`,
      "GET",
    );
    if (!membersResult.response.ok) {
      throw new Error(
        apiError(membersResult.body, "メンバーを読み込めませんでした。"),
      );
    }
    renderMembers(
      app.querySelector("[data-members]"),
      membersResult.body.members,
      roomId,
      roomResult.isOwner,
    );
    if (roomResult.isOwner) await loadJoinRequests(roomId);
  } catch (requestError) {
    const error = app.querySelector("[data-page-error]");
    if (error) {
      error.textContent = errorText(requestError);
      error.hidden = false;
    } else {
      renderNotice(
        "メンバー",
        errorText(requestError),
        '<a class="back-link" href="/chat/">ルーム一覧へ戻る</a>',
      );
    }
  }
}

function renderMembers(container, members, roomId, isOwner) {
  container.replaceChildren();
  if (!Array.isArray(members) || members.length === 0) {
    container.textContent = "メンバーはいません。";
    return;
  }
  for (const member of members) {
    const item = document.createElement("div");
    item.className = "member-card";
    const name = document.createElement("strong");
    name.textContent = member.displayName || "名前未設定";
    const role = document.createElement("span");
    role.textContent = roleLabel(member.role);
    item.append(name, role);
    if (isOwner && member.role !== "owner") {
      item.append(createMemberActions(roomId, member));
    }
    container.append(item);
  }
}

function createMemberActions(roomId, member) {
  const form = document.createElement("form");
  form.className = "member-actions";
  const label = document.createElement("label");
  label.textContent = "権限";
  const select = document.createElement("select");
  select.setAttribute(
    "aria-label",
    `${member.displayName || "メンバー"}の権限`,
  );
  for (
    const [value, text] of [
      ["viewer", "閲覧のみ"],
      ["writer", "書き込み可"],
    ]
  ) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    option.selected = member.role === value;
    select.append(option);
  }
  label.append(select);
  const update = document.createElement("button");
  update.type = "submit";
  update.textContent = "権限を変更";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "secondary danger";
  remove.textContent = "参加解除";
  const error = document.createElement("p");
  error.className = "form-error";
  error.hidden = true;
  form.append(label, update, remove, error);

  const act = async (action, body) => {
    update.disabled = remove.disabled = select.disabled = true;
    error.hidden = true;
    try {
      const result = await requestJson(
        `/api/chat/rooms/${encodeURIComponent(roomId)}/members/${
          encodeURIComponent(member.userId)
        }`,
        action === "role" ? "PATCH" : "DELETE",
        body,
        true,
      );
      if (!result.response.ok) {
        throw new Error(
          apiError(result.body, "メンバー情報を更新できませんでした。"),
        );
      }
      await renderMembersPage(roomId);
    } catch (requestError) {
      error.textContent = errorText(requestError);
      error.hidden = false;
      update.disabled = remove.disabled = select.disabled = false;
    }
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void act("role", { role: select.value });
  });
  remove.addEventListener("click", () => {
    if (
      !confirm(
        `${member.displayName || "このメンバー"}の参加を解除しますか？`,
      )
    ) return;
    void act("remove");
  });
  return form;
}

async function loadJoinRequests(roomId) {
  const container = app.querySelector("[data-requests]");
  const result = await requestJson(
    `/api/chat/rooms/${encodeURIComponent(roomId)}/requests`,
    "GET",
  );
  if (!result.response.ok) {
    throw new Error(apiError(result.body, "参加申請を読み込めませんでした。"));
  }
  container.replaceChildren();
  if (
    !Array.isArray(result.body.requests) || result.body.requests.length === 0
  ) {
    container.textContent = "承認待ちの申請はありません。";
    return;
  }
  for (const request of result.body.requests) {
    const card = document.createElement("div");
    card.className = "request-card";
    const name = document.createElement("strong");
    name.textContent = request.applicant?.displayName || "名前未設定";
    const form = document.createElement("form");
    form.className = "request-actions";
    const label = document.createElement("label");
    const select = document.createElement("select");
    select.setAttribute("aria-label", "承認する権限");
    for (
      const [value, text] of [
        ["viewer", "閲覧のみ"],
        ["writer", "書き込み可"],
      ]
    ) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      select.append(option);
    }
    label.textContent = "承認する権限";
    label.append(select);
    const approve = document.createElement("button");
    approve.type = "submit";
    approve.textContent = "承認";
    const reject = document.createElement("button");
    reject.type = "button";
    reject.className = "secondary";
    reject.textContent = "拒否";
    const error = document.createElement("p");
    error.className = "form-error";
    error.hidden = true;
    form.append(label, approve, reject, error);
    card.append(name, form);
    container.append(card);
    const act = async (action) => {
      approve.disabled = reject.disabled = true;
      try {
        const body = action === "approve" ? { role: select.value } : {};
        const update = await requestJson(
          `/api/chat/rooms/${encodeURIComponent(roomId)}/requests/${
            encodeURIComponent(request.userId)
          }/${action}`,
          "POST",
          body,
          true,
        );
        if (!update.response.ok) {
          throw new Error(
            apiError(update.body, "申請を更新できませんでした。"),
          );
        }
        await renderMembersPage(roomId);
      } catch (requestError) {
        error.textContent = errorText(requestError);
        error.hidden = false;
        approve.disabled = reject.disabled = false;
      }
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void act("approve");
    });
    reject.addEventListener("click", () => void act("reject"));
  }
}

async function renderRoomSettings(roomId) {
  clearRetryTimer();
  try {
    if (!await requireChatUser()) return;
    const result = await loadRoom(roomId);
    if (!result) return;
    if (!result.isOwner) {
      renderNotice(
        "ルーム設定",
        "このルームを変更できるのはオーナーだけです。",
        `<a class="back-link" href="/chat/rooms/${
          encodeURIComponent(roomId)
        }">ルームへ戻る</a>`,
      );
      return;
    }
    renderPanel(`
      <p class="eyebrow">チャットルーム</p><h1 id="chatTitle">ルーム設定</h1>
      <form class="stack" data-room-settings novalidate>
        <label for="roomName">ルーム名</label>
        <input id="roomName" name="roomName" type="text" required maxlength="50" autocomplete="off" />
        <label for="roomDescription">説明 <span class="optional">任意</span></label>
        <textarea id="roomDescription" name="roomDescription" maxlength="200" rows="4"></textarea>
        <p class="form-error" data-error role="alert" hidden></p><p class="form-success" data-success role="status" hidden></p>
        <button type="submit">変更を保存</button>
      </form>
      <a class="back-link" href="/chat/rooms/${
      encodeURIComponent(roomId)
    }">ルームへ戻る</a>`);
    const form = app.querySelector("[data-room-settings]");
    form.elements.roomName.value = result.room.name;
    form.elements.roomDescription.value = result.room.description;
    const error = form.querySelector("[data-error]");
    const success = form.querySelector("[data-success]");
    const button = form.querySelector("button");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = form.elements.roomName.value.trim();
      const description = form.elements.roomDescription.value.trim();
      if (!name || name.length > 50 || description.length > 200) {
        error.textContent =
          "ルーム名は1〜50文字、説明は200文字までで入力してください。";
        error.hidden = false;
        return;
      }
      button.disabled = true;
      button.textContent = "保存中…";
      try {
        const update = await requestJson(
          `/api/chat/rooms/${encodeURIComponent(roomId)}`,
          "PATCH",
          { name, description },
          true,
        );
        if (!update.response.ok) {
          throw new Error(
            apiError(update.body, "ルームを更新できませんでした。"),
          );
        }
        form.elements.roomName.value = update.body.room.name;
        form.elements.roomDescription.value = update.body.room.description;
        success.textContent = "変更を保存しました。";
        success.hidden = false;
      } catch (requestError) {
        error.textContent = errorText(requestError);
        error.hidden = false;
      } finally {
        button.disabled = false;
        button.textContent = "変更を保存";
      }
    });
  } catch (requestError) {
    renderNotice(
      "ルーム設定",
      errorText(requestError),
      '<a class="back-link" href="/chat/">ルーム一覧へ戻る</a>',
    );
  }
}

async function renderProtectedPlaceholder() {
  clearRetryTimer();
  try {
    const current = await getCurrentUser();
    if (!current) {
      navigate(loginUrl(currentReturnTo()));
      return;
    }
    if (current.needsProfile) {
      navigate(
        `/chat/profile?setup=1&returnTo=${
          encodeURIComponent(currentReturnTo())
        }`,
      );
      return;
    }
    renderNotice(
      "チャット",
      "この画面は準備中です。",
      '<a class="back-link" href="/chat/">チャットへ戻る</a>',
    );
  } catch (requestError) {
    renderNotice(
      "チャット",
      errorText(requestError),
      '<a class="back-link" href="/chat/">チャットへ戻る</a>',
    );
  }
}

function start() {
  const path = globalThis.location.pathname.replace(/\/+$/, "") || "/";
  if (path === "/chat/login") {
    const returnTo = safeReturnTo(
      new URLSearchParams(globalThis.location.search).get("returnTo"),
    ) ?? "/chat/";
    renderLoginEmail({ email: "", returnTo });
  } else if (path === "/chat/profile") {
    void renderProfile();
  } else if (path === "/chat") {
    void renderChatHome();
  } else if (path === "/chat/rooms/new") {
    void renderRoomCreate();
  } else {
    const settingsMatch = path.match(
      /^\/chat\/rooms\/([A-Za-z0-9_-]{16,64})\/settings$/,
    );
    const membersMatch = path.match(
      /^\/chat\/rooms\/([A-Za-z0-9_-]{16,64})\/members$/,
    );
    const roomMatch = path.match(/^\/chat\/rooms\/([A-Za-z0-9_-]{16,64})$/);
    if (settingsMatch) {
      void renderRoomSettings(settingsMatch[1]);
    } else if (membersMatch) {
      void renderMembersPage(membersMatch[1]);
    } else if (roomMatch) {
      void renderRoomPage(roomMatch[1]);
    } else {
      void renderProtectedPlaceholder();
    }
  }
}

start();
