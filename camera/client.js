const databaseName = "paradise-local-camera";
const storeName = "photos";
const databaseVersion = 1;

const els = {
  captureButton: document.querySelector("#captureButton"),
  cameraInput: document.querySelector("#cameraInput"),
  captureStatus: document.querySelector("#captureStatus"),
  photoCount: document.querySelector("#photoCount"),
  storageUsage: document.querySelector("#storageUsage"),
  requestPersistence: document.querySelector("#requestPersistence"),
  grid: document.querySelector("#photoGrid"),
  empty: document.querySelector("#emptyLibrary"),
  dialog: document.querySelector("#photoDialog"),
  dialogImage: document.querySelector("#dialogImage"),
  dialogDate: document.querySelector("#dialogDate"),
  dialogSize: document.querySelector("#dialogSize"),
  closeDialog: document.querySelector("#closeDialog"),
  saveToPhotos: document.querySelector("#saveToPhotos"),
  deletePhoto: document.querySelector("#deletePhoto"),
  saveHelp: document.querySelector("#saveHelp"),
};

let databasePromise;
let selectedPhoto = null;
let objectUrls = [];
let dialogUrl = null;

els.captureButton.addEventListener("click", () => els.cameraInput.click());
els.cameraInput.addEventListener("change", () => void captureSelectedPhoto());
els.closeDialog.addEventListener("click", closePhotoDialog);
els.dialog.addEventListener("click", (event) => {
  if (event.target === els.dialog) closePhotoDialog();
});
els.dialog.addEventListener("close", clearDialogPhoto);
els.saveToPhotos.addEventListener("click", () => void saveSelectedToPhotos());
els.deletePhoto.addEventListener("click", () => void deleteSelectedPhoto());
els.requestPersistence.addEventListener(
  "click",
  () => void requestPersistentStorage(),
);

void initialize();

async function initialize() {
  if (!("indexedDB" in globalThis)) {
    setStatus("このブラウザでは端末内保存を利用できません", "error");
    els.captureButton.disabled = true;
    return;
  }

  try {
    await openDatabase();
    await renderLibrary();
    await updateStorageUsage();
    await updatePersistenceButton();
  } catch (error) {
    console.warn("写真ライブラリを開けませんでした", error);
    setStatus("端末内の写真保存領域を開けませんでした", "error");
  }
}

function openDatabase() {
  databasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(storeName)) {
        const store = database.createObjectStore(storeName, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
    request.addEventListener(
      "blocked",
      () => reject(new Error("データベースの更新がブロックされました")),
    );
  });
  return databasePromise;
}

async function captureSelectedPhoto() {
  const file = els.cameraInput.files?.[0];
  if (!file) return;
  els.captureButton.disabled = true;
  setStatus("写真を端末内へ保存しています…");

  try {
    const photo = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      name: normalizeFileName(file.name),
      type: file.type || "image/jpeg",
      size: file.size,
      blob: file,
    };
    await putPhoto(photo);
    setStatus("端末内へ保存しました", "success");
    await renderLibrary();
    await updateStorageUsage();
  } catch (error) {
    console.warn("写真を保存できませんでした", error);
    setStatus(
      error?.name === "QuotaExceededError"
        ? "端末の保存容量が不足しています"
        : "写真を保存できませんでした",
      "error",
    );
  } finally {
    els.cameraInput.value = "";
    els.captureButton.disabled = false;
  }
}

async function putPhoto(photo) {
  const database = await openDatabase();
  await transactionPromise(database, "readwrite", (store) => store.put(photo));
}

async function getPhotos() {
  const database = await openDatabase();
  return await new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).getAll();
    request.addEventListener("success", () => {
      const photos = Array.isArray(request.result) ? request.result : [];
      photos.sort((a, b) =>
        String(b.createdAt).localeCompare(String(a.createdAt))
      );
      resolve(photos);
    });
    request.addEventListener("error", () => reject(request.error));
  });
}

async function removePhoto(id) {
  const database = await openDatabase();
  await transactionPromise(database, "readwrite", (store) => store.delete(id));
}

function transactionPromise(database, mode, operation) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    operation(transaction.objectStore(storeName));
    transaction.addEventListener("complete", resolve);
    transaction.addEventListener("error", () => reject(transaction.error));
    transaction.addEventListener("abort", () => reject(transaction.error));
  });
}

async function renderLibrary() {
  const photos = await getPhotos();
  releaseObjectUrls();
  els.grid.replaceChildren();
  els.photoCount.textContent = String(photos.length);
  els.empty.hidden = photos.length > 0;

  photos.forEach((photo) => {
    const url = URL.createObjectURL(photo.blob);
    objectUrls.push(url);
    const button = document.createElement("button");
    button.className = "photo-tile";
    button.type = "button";
    button.setAttribute(
      "aria-label",
      `${formatDate(photo.createdAt)}に撮影した写真を開く`,
    );

    const image = document.createElement("img");
    image.src = url;
    image.alt = "";
    image.loading = "lazy";

    const meta = document.createElement("span");
    const date = document.createElement("strong");
    date.textContent = formatDate(photo.createdAt);
    const size = document.createElement("small");
    size.textContent = formatBytes(photo.size || photo.blob?.size || 0);
    meta.append(date, size);
    button.append(image, meta);
    button.addEventListener("click", () => openPhotoDialog(photo));
    els.grid.append(button);
  });
}

function openPhotoDialog(photo) {
  selectedPhoto = photo;
  clearDialogUrl();
  dialogUrl = URL.createObjectURL(photo.blob);
  els.dialogImage.src = dialogUrl;
  els.dialogDate.textContent = formatLongDate(photo.createdAt);
  els.dialogSize.textContent = formatBytes(photo.size || photo.blob?.size || 0);
  els.saveHelp.textContent = navigator.share
    ? "共有画面が開いたら「画像を保存」を選んでください。"
    : "保存先を選択して写真をダウンロードしてください。";
  els.dialog.showModal();
}

function closePhotoDialog() {
  if (els.dialog.open) els.dialog.close();
}

function clearDialogPhoto() {
  selectedPhoto = null;
  els.dialogImage.removeAttribute("src");
  clearDialogUrl();
}

async function saveSelectedToPhotos() {
  if (!selectedPhoto) return;
  const extension = extensionForType(selectedPhoto.type);
  const fileName = selectedPhoto.name ||
    `paradise-photo-${dateForFile(selectedPhoto.createdAt)}.${extension}`;
  const file = new File([selectedPhoto.blob], fileName, {
    type: selectedPhoto.type,
  });
  els.saveToPhotos.disabled = true;

  try {
    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: "撮影した写真" });
      return;
    }
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  } catch (error) {
    if (error?.name !== "AbortError") {
      console.warn("写真を書き出せませんでした", error);
      els.saveHelp.textContent =
        "写真を書き出せませんでした。もう一度お試しください。";
    }
  } finally {
    els.saveToPhotos.disabled = false;
  }
}

async function deleteSelectedPhoto() {
  if (!selectedPhoto) return;
  if (
    !confirm("この端末内から写真を削除しますか？この操作は元に戻せません。")
  ) return;
  const id = selectedPhoto.id;
  els.deletePhoto.disabled = true;
  try {
    await removePhoto(id);
    closePhotoDialog();
    setStatus("写真を削除しました", "success");
    await renderLibrary();
    await updateStorageUsage();
  } catch (error) {
    console.warn("写真を削除できませんでした", error);
    els.saveHelp.textContent = "写真を削除できませんでした。";
  } finally {
    els.deletePhoto.disabled = false;
  }
}

async function updateStorageUsage() {
  if (!navigator.storage?.estimate) {
    els.storageUsage.textContent = "端末内に保存";
    return;
  }
  try {
    const estimate = await navigator.storage.estimate();
    els.storageUsage.textContent = `このサイトの使用量 ${
      formatBytes(estimate.usage || 0)
    }`;
  } catch {
    els.storageUsage.textContent = "端末内に保存";
  }
}

async function updatePersistenceButton() {
  if (!navigator.storage?.persisted) {
    els.requestPersistence.hidden = true;
    return;
  }
  const persistent = await navigator.storage.persisted();
  els.requestPersistence.textContent = persistent
    ? "保存保護済み"
    : "保存を安定させる";
  els.requestPersistence.disabled = persistent;
}

async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return;
  const granted = await navigator.storage.persist();
  els.requestPersistence.textContent = granted
    ? "保存保護済み"
    : "ホーム画面への追加がおすすめ";
  els.requestPersistence.disabled = granted;
}

function setStatus(message, kind = "") {
  els.captureStatus.textContent = message;
  els.captureStatus.className = `capture-status${kind ? ` ${kind}` : ""}`;
}

function releaseObjectUrls() {
  objectUrls.forEach((url) => URL.revokeObjectURL(url));
  objectUrls = [];
}

function clearDialogUrl() {
  if (dialogUrl) URL.revokeObjectURL(dialogUrl);
  dialogUrl = null;
}

function normalizeFileName(value) {
  const name = String(value || "").trim();
  return name && name.length <= 120
    ? name
    : `paradise-photo-${dateForFile(new Date().toISOString())}.jpg`;
}

function extensionForType(type) {
  if (type === "image/png") return "png";
  if (type === "image/heic" || type === "image/heif") return "heic";
  return "jpg";
}

function formatDate(value) {
  const date = new Date(value);
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatLongDate(value) {
  const date = new Date(value);
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function dateForFile(value) {
  return new Date(value).toISOString().replaceAll(":", "-").replace(
    ".000Z",
    "Z",
  );
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
