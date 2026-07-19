const app = document.querySelector("#chatApp");
const apiOrigin = globalThis.location.origin;
let retryTimer = null;

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

function renderPanel(content) {
  app.innerHTML = `
    <section class="chat-panel" aria-labelledby="chatTitle">
      <p class="eyebrow">Paradise Timer</p>
      ${content}
    </section>`;
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
    const error = form.querySelector("[data-error]");
    const success = form.querySelector("[data-success]");
    const button = form.querySelector("button");
    input.value = current.user.displayName ?? "";
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
          body: JSON.stringify({ displayName }),
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
    renderNotice(
      "チャット",
      "ログイン済みです。ルーム一覧は次の実装で追加されます。",
      '<a class="button-link" href="/chat/profile">プロフィール</a><button class="text-button" type="button" data-logout>ログアウト</button><a class="back-link" href="/">タイマーへ戻る</a>',
    );
    const logout = app.querySelector("[data-logout]");
    logout.addEventListener("click", async () => {
      logout.disabled = true;
      try {
        const result = await postJson("/api/chat/auth/logout", {}, true);
        if (!result.response.ok) {
          throw new Error(
            apiError(result.body, "ログアウトできませんでした。"),
          );
        }
        navigate("/chat/");
      } catch (requestError) {
        logout.disabled = false;
        globalThis.alert(errorText(requestError));
      }
    });
  } catch (requestError) {
    renderNotice(
      "チャット",
      errorText(requestError),
      `<a href="${loginUrl("/chat/")}">ログイン</a>`,
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
  } else {
    void renderProtectedPlaceholder();
  }
}

start();
