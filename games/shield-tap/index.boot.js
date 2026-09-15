const GODOT_CONFIG = {"args":[],"canvasResizePolicy":2,"emscriptenPoolSize":8,"ensureCrossOriginIsolationHeaders":true,"executable":"index","experimentalVK":false,"fileSizes":{"index-v12.pck":13433848,"index.wasm":39514754},"focusCanvas":true,"gdextensionLibs":[],"godotPoolSize":4,"mainPack":"index-v12.pck"};
const GODOT_THREADS_ENABLED = false;
const engine = new Engine(GODOT_CONFIG);

(() => {
	const statusOverlay = document.getElementById("status");
	const statusProgress = document.getElementById("status-progress");
	const statusNotice = document.getElementById("status-notice");
	let initializing = true;
	let statusMode = "";

	function setStatusMode(mode) {
		if (statusMode === mode || !initializing) return;
		if (mode === "hidden") {
			statusOverlay.remove();
			initializing = false;
			return;
		}
		statusOverlay.style.visibility = "visible";
		statusProgress.style.display = mode === "progress" ? "block" : "none";
		statusNotice.style.display = mode === "notice" ? "block" : "none";
		statusMode = mode;
	}

	function displayFailureNotice(error) {
		console.error(error);
		statusNotice.replaceChildren(document.createTextNode(
			error instanceof Error ? error.message : String(error),
		));
		setStatusMode("notice");
		initializing = false;
	}

	const missing = Engine.getMissingFeatures({ threads: GODOT_THREADS_ENABLED });
	if (missing.length !== 0) {
		displayFailureNotice(`Error: ${missing.join(", ")}`);
		return;
	}

	setStatusMode("progress");
	engine.startGame({
		onProgress(current, total) {
			if (current > 0 && total > 0) {
				statusProgress.value = current;
				statusProgress.max = total;
			} else {
				statusProgress.removeAttribute("value");
				statusProgress.removeAttribute("max");
			}
		},
	}).then(() => setStatusMode("hidden"), displayFailureNotice);
})();
