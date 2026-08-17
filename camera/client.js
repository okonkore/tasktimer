import {
  createProjectiveMap,
  defaultCorners,
  detectChekiCorners,
  isUsableQuadrilateral,
  orderCorners,
} from "./geometry.js";

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
  adjustPhoto: document.querySelector("#adjustPhoto"),
  deletePhoto: document.querySelector("#deletePhoto"),
  saveHelp: document.querySelector("#saveHelp"),
  cropDialog: document.querySelector("#cropDialog"),
  cropCanvas: document.querySelector("#cropCanvas"),
  cropTitle: document.querySelector("#cropTitle"),
  cropStatus: document.querySelector("#cropStatus"),
  cropHint: document.querySelector("#cropHint"),
  cancelCrop: document.querySelector("#cancelCrop"),
  detectAgain: document.querySelector("#detectAgain"),
  saveCrop: document.querySelector("#saveCrop"),
};

let databasePromise;
let selectedPhoto = null;
let objectUrls = [];
let dialogUrl = null;
let editorPhoto = null;
let editorImage = null;
let editorCorners = defaultCorners();
let editorIsNew = false;
let activeCorner = -1;

els.captureButton.addEventListener("click", () => els.cameraInput.click());
els.cameraInput.addEventListener("change", () => void captureSelectedPhoto());
els.closeDialog.addEventListener("click", closePhotoDialog);
els.dialog.addEventListener("click", (event) => {
  if (event.target === els.dialog) closePhotoDialog();
});
els.dialog.addEventListener("close", clearDialogPhoto);
els.saveToPhotos.addEventListener("click", () => void saveSelectedToPhotos());
els.adjustPhoto.addEventListener("click", () => void adjustSelectedPhoto());
els.deletePhoto.addEventListener("click", () => void deleteSelectedPhoto());
els.requestPersistence.addEventListener(
  "click",
  () => void requestPersistentStorage(),
);
els.cancelCrop.addEventListener("click", closeCropEditor);
els.detectAgain.addEventListener("click", () => void detectEditorFrame());
els.saveCrop.addEventListener("click", () => void saveEditorCrop());
els.cropCanvas.addEventListener("pointerdown", beginCornerDrag);
els.cropCanvas.addEventListener("pointermove", moveCornerDrag);
els.cropCanvas.addEventListener("pointerup", endCornerDrag);
els.cropCanvas.addEventListener("pointercancel", endCornerDrag);
globalThis.addEventListener("resize", resizeCropEditor);

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
  if (!String(file.type).startsWith("image/")) {
    setStatus("画像ファイルを選択してください", "error");
    els.cameraInput.value = "";
    return;
  }
  els.captureButton.disabled = true;
  setStatus("チェキの四隅を検出しています…");

  try {
    const image = await loadImage(file);
    const detection = detectFrameFromImage(image);
    const photo = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      name: normalizeFileName(file.name),
      type: file.type || "image/jpeg",
      size: file.size,
      width: image.naturalWidth,
      height: image.naturalHeight,
      blob: file,
      cropBlob: null,
      cropType: "image/jpeg",
      corners: detection.corners,
      detectionMethod: detection.method,
      detectionConfidence: detection.confidence,
    };
    await openCropEditor(photo, true, image);
    setStatus("四隅を確認して「この範囲で保存」を押してください");
  } catch (error) {
    console.warn("写真を読み込めませんでした", error);
    setStatus("写真を読み込めませんでした", "error");
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
    const displayBlob = photo.cropBlob || photo.blob;
    const url = URL.createObjectURL(displayBlob);
    objectUrls.push(url);
    const button = document.createElement("button");
    button.className = "photo-tile";
    button.type = "button";
    button.setAttribute(
      "aria-label",
      `${formatDate(photo.createdAt)}に撮影したチェキを開く`,
    );

    const image = document.createElement("img");
    image.src = url;
    image.alt = "";
    image.loading = "lazy";

    const meta = document.createElement("span");
    const date = document.createElement("strong");
    date.textContent = formatDate(photo.createdAt);
    const size = document.createElement("small");
    size.textContent = photo.cropBlob ? "切り抜き済み" : "範囲未設定";
    meta.append(date, size);
    button.append(image, meta);
    button.addEventListener("click", () => openPhotoDialog(photo));
    els.grid.append(button);
  });
}

function openPhotoDialog(photo) {
  selectedPhoto = photo;
  clearDialogUrl();
  const displayBlob = photo.cropBlob || photo.blob;
  dialogUrl = URL.createObjectURL(displayBlob);
  els.dialogImage.src = dialogUrl;
  els.dialogDate.textContent = formatLongDate(photo.createdAt);
  els.dialogSize.textContent = `${formatBytes(displayBlob.size)} · ${
    photo.cropBlob ? "チェキ範囲のみ" : "元の写真"
  }`;
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

async function adjustSelectedPhoto() {
  if (!selectedPhoto) return;
  const photo = selectedPhoto;
  closePhotoDialog();
  try {
    await openCropEditor(photo, false);
  } catch (error) {
    console.warn("範囲調整を開けませんでした", error);
    setStatus("範囲調整を開けませんでした", "error");
  }
}

async function openCropEditor(photo, isNew, preloadedImage = null) {
  editorPhoto = photo;
  editorIsNew = isNew;
  editorImage = preloadedImage || await loadImage(photo.blob);
  editorCorners = orderCorners(photo.corners || defaultCorners());
  els.cropTitle.textContent = isNew ? "チェキの四隅を確認" : "チェキ範囲を調整";
  updateCropStatus(photo.detectionConfidence, photo.detectionMethod);
  if (!els.cropDialog.open) els.cropDialog.showModal();
  resizeCropEditor();
}

function closeCropEditor() {
  if (els.cropDialog.open) els.cropDialog.close();
  editorPhoto = null;
  editorImage = null;
  editorCorners = defaultCorners();
  activeCorner = -1;
  if (editorIsNew) setStatus("撮影した写真の保存をキャンセルしました");
  editorIsNew = false;
}

async function detectEditorFrame() {
  if (!editorImage || !editorPhoto) return;
  els.detectAgain.disabled = true;
  els.cropHint.textContent = "四隅を再検出しています…";
  await nextFrame();
  const detection = detectFrameFromImage(editorImage);
  editorCorners = orderCorners(detection.corners);
  editorPhoto.detectionMethod = detection.method;
  editorPhoto.detectionConfidence = detection.confidence;
  updateCropStatus(detection.confidence, detection.method);
  renderCropEditor();
  els.detectAgain.disabled = false;
}

function detectFrameFromImage(image) {
  const maximum = 260;
  const scale = Math.min(
    1,
    maximum / Math.max(image.naturalWidth, image.naturalHeight),
  );
  const width = Math.max(12, Math.round(image.naturalWidth * scale));
  const height = Math.max(12, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, width, height);
  return detectChekiCorners(context.getImageData(0, 0, width, height));
}

function updateCropStatus(confidence, method) {
  const automatic = method === "white-frame";
  const percent = Math.round((Number(confidence) || 0) * 100);
  els.cropStatus.textContent = automatic
    ? `自動検出 ${percent}%`
    : "自動検出できなかったため仮の範囲を表示";
  els.cropStatus.className = `crop-status ${
    automatic ? "detected" : "fallback"
  }`;
  els.cropHint.textContent =
    "4つの丸を指で動かし、チェキの角に合わせてください。";
}

function resizeCropEditor() {
  if (!els.cropDialog.open || !editorImage) return;
  const maximumWidth = Math.min(globalThis.innerWidth - 28, 720);
  const maximumHeight = Math.min(globalThis.innerHeight * 0.61, 720);
  const scale = Math.min(
    maximumWidth / editorImage.naturalWidth,
    maximumHeight / editorImage.naturalHeight,
    1,
  );
  els.cropCanvas.width = Math.max(
    1,
    Math.round(editorImage.naturalWidth * scale),
  );
  els.cropCanvas.height = Math.max(
    1,
    Math.round(editorImage.naturalHeight * scale),
  );
  renderCropEditor();
}

function renderCropEditor() {
  if (!editorImage) return;
  const canvas = els.cropCanvas;
  const context = canvas.getContext("2d");
  const points = editorCorners.map((point) => ({
    x: point.x * canvas.width,
    y: point.y * canvas.height,
  }));
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(editorImage, 0, 0, canvas.width, canvas.height);
  context.fillStyle = "rgba(2, 10, 9, .62)";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.save();
  tracePolygon(context, points);
  context.clip();
  context.drawImage(editorImage, 0, 0, canvas.width, canvas.height);
  context.restore();
  tracePolygon(context, points);
  context.strokeStyle = "#7ef0da";
  context.lineWidth = 2.5;
  context.stroke();

  points.forEach((point, index) => {
    context.beginPath();
    context.arc(point.x, point.y, 13, 0, Math.PI * 2);
    context.fillStyle = "#fff";
    context.fill();
    context.lineWidth = 4;
    context.strokeStyle = "#176f6b";
    context.stroke();
    context.fillStyle = "#11534f";
    context.font = "bold 11px system-ui";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(String(index + 1), point.x, point.y + 0.5);
  });
}

function tracePolygon(context, points) {
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length; index++) {
    context.lineTo(points[index].x, points[index].y);
  }
  context.closePath();
}

function beginCornerDrag(event) {
  if (!editorImage) return;
  const point = canvasPoint(event);
  const canvas = els.cropCanvas;
  const distances = editorCorners.map((corner) =>
    Math.hypot(
      corner.x * canvas.width - point.x,
      corner.y * canvas.height - point.y,
    )
  );
  activeCorner = distances.indexOf(Math.min(...distances));
  if (distances[activeCorner] > 42) {
    activeCorner = -1;
    return;
  }
  canvas.setPointerCapture(event.pointerId);
  event.preventDefault();
}

function moveCornerDrag(event) {
  if (activeCorner < 0) return;
  const point = canvasPoint(event);
  editorCorners[activeCorner] = {
    x: clamp(point.x / els.cropCanvas.width, 0.005, 0.995),
    y: clamp(point.y / els.cropCanvas.height, 0.005, 0.995),
  };
  renderCropEditor();
  event.preventDefault();
}

function endCornerDrag(event) {
  if (activeCorner < 0) return;
  if (els.cropCanvas.hasPointerCapture(event.pointerId)) {
    els.cropCanvas.releasePointerCapture(event.pointerId);
  }
  activeCorner = -1;
  event.preventDefault();
}

function canvasPoint(event) {
  const rect = els.cropCanvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * els.cropCanvas.width / rect.width,
    y: (event.clientY - rect.top) * els.cropCanvas.height / rect.height,
  };
}

async function saveEditorCrop() {
  if (!editorPhoto || !editorImage) return;
  const ordered = orderCorners(editorCorners);
  if (!isUsableQuadrilateral(ordered)) {
    els.cropHint.textContent =
      "四隅が交差しているか、範囲が小さすぎます。丸を調整してください。";
    els.cropHint.className = "crop-hint error";
    return;
  }
  els.saveCrop.disabled = true;
  els.detectAgain.disabled = true;
  els.cropHint.className = "crop-hint";
  els.cropHint.textContent = "チェキ範囲だけを生成しています…";
  await nextFrame();

  try {
    const cropBlob = await createPerspectiveCrop(editorImage, ordered);
    const now = new Date().toISOString();
    const photo = {
      ...editorPhoto,
      width: editorImage.naturalWidth,
      height: editorImage.naturalHeight,
      corners: ordered,
      cropBlob,
      cropType: "image/jpeg",
      cropSize: cropBlob.size,
      updatedAt: now,
    };
    await putPhoto(photo);
    editorIsNew = false;
    closeCropEditor();
    setStatus("チェキの四隅と切り抜きを端末内へ保存しました", "success");
    await renderLibrary();
    await updateStorageUsage();
  } catch (error) {
    console.warn("チェキ範囲を保存できませんでした", error);
    els.cropHint.textContent = error?.name === "QuotaExceededError"
      ? "端末の保存容量が不足しています"
      : "チェキ範囲を保存できませんでした。もう一度お試しください。";
    els.cropHint.className = "crop-hint error";
  } finally {
    els.saveCrop.disabled = false;
    els.detectAgain.disabled = false;
  }
}

async function createPerspectiveCrop(image, corners) {
  const maximumSource = 2200;
  const sourceScale = Math.min(
    1,
    maximumSource / Math.max(image.naturalWidth, image.naturalHeight),
  );
  const sourceWidth = Math.max(2, Math.round(image.naturalWidth * sourceScale));
  const sourceHeight = Math.max(
    2,
    Math.round(image.naturalHeight * sourceScale),
  );
  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = sourceWidth;
  sourceCanvas.height = sourceHeight;
  const sourceContext = sourceCanvas.getContext("2d", {
    willReadFrequently: true,
  });
  sourceContext.drawImage(image, 0, 0, sourceWidth, sourceHeight);
  const source = sourceContext.getImageData(0, 0, sourceWidth, sourceHeight);
  const ordered = orderCorners(corners);
  const pixelCorners = ordered.map((point) => ({
    x: point.x * sourceWidth,
    y: point.y * sourceHeight,
  }));
  const estimatedWidth = (
    distancePoints(pixelCorners[0], pixelCorners[1]) +
    distancePoints(pixelCorners[3], pixelCorners[2])
  ) / 2;
  const estimatedHeight = (
    distancePoints(pixelCorners[0], pixelCorners[3]) +
    distancePoints(pixelCorners[1], pixelCorners[2])
  ) / 2;
  const maximumOutput = 1600;
  const outputScale = Math.min(
    1,
    maximumOutput / Math.max(estimatedWidth, estimatedHeight),
  );
  const outputWidth = clamp(
    Math.round(estimatedWidth * outputScale),
    64,
    maximumOutput,
  );
  const outputHeight = clamp(
    Math.round(estimatedHeight * outputScale),
    64,
    maximumOutput,
  );
  const outputCanvas = document.createElement("canvas");
  outputCanvas.width = outputWidth;
  outputCanvas.height = outputHeight;
  const outputContext = outputCanvas.getContext("2d");
  const output = outputContext.createImageData(outputWidth, outputHeight);
  const map = createProjectiveMap(ordered, sourceWidth, sourceHeight);

  for (let y = 0; y < outputHeight; y++) {
    const vertical = y / Math.max(1, outputHeight - 1);
    for (let x = 0; x < outputWidth; x++) {
      const horizontal = x / Math.max(1, outputWidth - 1);
      const divisor = map.g * horizontal + map.h * vertical + 1;
      const sourceX = clamp(
        Math.round((map.a * horizontal + map.b * vertical + map.c) / divisor),
        0,
        sourceWidth - 1,
      );
      const sourceY = clamp(
        Math.round((map.d * horizontal + map.e * vertical + map.f) / divisor),
        0,
        sourceHeight - 1,
      );
      const sourceIndex = (sourceY * sourceWidth + sourceX) * 4;
      const outputIndex = (y * outputWidth + x) * 4;
      output.data[outputIndex] = source.data[sourceIndex];
      output.data[outputIndex + 1] = source.data[sourceIndex + 1];
      output.data[outputIndex + 2] = source.data[sourceIndex + 2];
      output.data[outputIndex + 3] = 255;
    }
  }
  outputContext.putImageData(output, 0, 0);
  return await canvasToBlob(outputCanvas, "image/jpeg", 0.92);
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("画像を生成できませんでした")),
      type,
      quality,
    );
  });
}

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.addEventListener("load", () => {
      URL.revokeObjectURL(url);
      resolve(image);
    }, { once: true });
    image.addEventListener("error", () => {
      URL.revokeObjectURL(url);
      reject(new Error("画像を表示できませんでした"));
    }, { once: true });
    image.src = url;
  });
}

async function saveSelectedToPhotos() {
  if (!selectedPhoto) return;
  const displayBlob = selectedPhoto.cropBlob || selectedPhoto.blob;
  const type = selectedPhoto.cropBlob
    ? "image/jpeg"
    : selectedPhoto.type || "image/jpeg";
  const extension = extensionForType(type);
  const fileName = `cheki-${dateForFile(selectedPhoto.createdAt)}.${extension}`;
  const file = new File([displayBlob], fileName, { type });
  els.saveToPhotos.disabled = true;

  try {
    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: "切り抜いたチェキ" });
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

function distancePoints(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}
