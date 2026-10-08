const $ = (id) => document.getElementById(id);
const elements = { input: $("prompts"), draftSection: $("draft-section"), draftTitle: $("draft-title"), draft: $("draft"), add: $("add"), queueTitle: $("queue-title"), queue: $("queue"), empty: $("empty"), status: $("status"), start: $("start"), pause: $("pause"), stop: $("stop") };
let state = { items: [], running: false, paused: false, message: "Abre un proyecto de Flow y prepara el modo Imagen o Video antes de iniciar.", error: false };
let draftPrompts = [];
let selectedDirectoryHandle = null;

function parsePrompts(text) {
  const lines = text.replace(/\r/g, "").split("\n");
  const marker = /^\s*(?:prompt\s*)?(\d+)\s*[:.)-]\s*(.*)$/i;
  const hasMarkers = lines.some((line) => marker.test(line));
  if (hasMarkers) {
    const prompts = [];
    let current = [];
    let started = false;
    for (const line of lines) {
      const match = line.match(marker);
      if (match) {
        const previous = current.join("\n").trim();
        if (previous) prompts.push(previous);
        current = match[2].trim() ? [match[2].trim()] : [];
        started = true;
      } else if (started) {
        current.push(line);
      }
    }
    const last = current.join("\n").trim();
    if (last) prompts.push(last);
    return prompts;
  }
  return text.split(/\n\s*\n+/).map((part) => part.trim()).filter(Boolean);
}

function promptPreview(text) {
  const details = document.createElement("details");
  details.className = "prompt";
  const summary = document.createElement("summary");
  const excerpt = text.replace(/\s+/g, " ").trim();
  summary.textContent = excerpt.length > 125 ? `${excerpt.slice(0, 125).trimEnd()}…` : excerpt;
  summary.setAttribute("aria-label", `${summary.textContent}. Mostrar u ocultar prompt completo`);
  const full = document.createElement("div");
  full.className = "prompt-full";
  full.textContent = text;
  details.append(summary, full);
  return details;
}

function render() {
  elements.draft.replaceChildren();
  elements.draftSection.hidden = draftPrompts.length === 0;
  elements.draftTitle.textContent = `Vista previa · ${draftPrompts.length} ${draftPrompts.length === 1 ? "prompt" : "prompts"}`;
  draftPrompts.forEach((prompt, index) => {
    const li = document.createElement("li");
    const number = document.createElement("span"); number.className = "num"; number.textContent = `${index + 1}.`;
    const content = promptPreview(prompt);
    li.append(number, content); elements.draft.append(li);
  });
  elements.add.textContent = `Añadir ${draftPrompts.length} ${draftPrompts.length === 1 ? "prompt" : "prompts"} a la cola`;
  elements.add.disabled = draftPrompts.length === 0;
  elements.add.hidden = draftPrompts.length === 0;
  elements.queue.replaceChildren();
  elements.empty.hidden = state.items.length > 0;
  state.items.forEach((item, index) => {
    const li = document.createElement("li"); li.dataset.status = item.status || "pending";
    const number = document.createElement("span"); number.className = "num"; number.textContent = `${index + 1}.`;
    const prompt = promptPreview(item.prompt);
    const status = document.createElement("span"); status.className = "state"; status.textContent = ({ pending: "Pendiente", running: "Generando", done: "Listo", error: "Revisar", review: "Revisar" })[item.status] || "Pendiente";
    li.append(number, prompt, status);
    if (item.status === "review" || item.status === "error") {
      const actions = document.createElement("div"); actions.className = "item-actions";
      const done = document.createElement("button"); done.className = "item-action"; done.dataset.action = "mark-done"; done.dataset.id = item.id; done.textContent = "Marcar listo";
      const retry = document.createElement("button"); retry.className = "item-action"; retry.dataset.action = "retry"; retry.dataset.id = item.id; retry.textContent = "Reintentar";
      actions.append(done, retry); li.append(actions);
    }
    if (item.unsavedOutput) {
      const retrySave = document.createElement("button");
      retrySave.className = "item-action"; retrySave.dataset.action = "save-output";
      retrySave.dataset.id = item.id; retrySave.textContent = "Guardar imagen";
      li.append(retrySave);
    }
    elements.queue.append(li);
  });
  const pending = state.items.filter((i) => i.status === "pending").length;
  elements.queueTitle.textContent = `Cola · ${pending} pendientes`;
  elements.status.textContent = state.message;
  elements.status.className = `status${state.error ? " error" : state.running ? " active" : ""}`;
  elements.start.disabled = state.running || pending === 0;
  elements.pause.disabled = !state.running;
  elements.pause.textContent = state.paused ? "Continuar" : "Pausar";
  elements.stop.disabled = !state.running;
}

async function load() {
  const saved = await chrome.storage.local.get(["flowQueue", "flowDownloadSettings"]);
  if (saved.flowQueue) state = { ...state, ...saved.flowQueue };
  const downloadSettings = saved.flowDownloadSettings || {};
  $("auto-download").checked = Boolean(downloadSettings.enabled);
  $("download-prefix").value = downloadSettings.prefix || "stick";
  if (downloadSettings.enabled) {
    const origins = ["https://flow-content.google/*", "https://*.googleusercontent.com/*", "https://*.googlevideo.com/*", "https://storage.googleapis.com/*"];
    if (!await chrome.permissions.contains({ origins })) {
      $("auto-download").checked = false;
      await chrome.storage.local.set({ flowDownloadSettings: { ...downloadSettings, enabled: false } });
    }
  }
  await refreshSelectedFolder();
  if (state.message?.startsWith("No encontré el cuadro de prompt o el botón de generación.")) {
    const interrupted = state.items.find((item) => item.status === "error");
    if (interrupted) interrupted.status = "pending";
    state.message = "El prompt que Flow no reconoció quedó pendiente. Recarga Flow y vuelve a iniciar la cola.";
  }
  if (state.running) {
    state.running = false;
    state.paused = false;
    state.items = state.items.map((item) => item.status === "running" ? { ...item, status: "review" } : item);
    state.message = "La cola se interrumpió. Revisa Flow y marca el prompt como listo o reinténtalo antes de continuar.";
    await save();
  }
  render();
}
async function save() { await chrome.storage.local.set({ flowQueue: state }); render(); }
async function saveDownloadSettings() {
  const current = await chrome.storage.local.get(["flowDownloadSettings", "flowDownloadNextNumber"]);
  const nextSettings = {
    enabled: $("auto-download").checked,
    prefix: $("download-prefix").value.trim() || "stick"
  };
  const previous = current.flowDownloadSettings || {};
  const update = { flowDownloadSettings: nextSettings };
  if (previous.prefix !== nextSettings.prefix) update.flowDownloadNextNumber = 1;
  await chrome.storage.local.set(update);
}

const folderDb = new Promise((resolve, reject) => {
  const request = indexedDB.open("flow-prompt-queue-files", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("handles");
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
async function saveDirectoryHandle(handle) {
  const db = await folderDb;
  await new Promise((resolve, reject) => {
    const tx = db.transaction("handles", "readwrite");
    tx.objectStore("handles").put(handle, "output-directory");
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}
async function getDirectoryHandle() {
  if (selectedDirectoryHandle) return selectedDirectoryHandle;
  const db = await folderDb;
  return new Promise((resolve, reject) => {
    const request = db.transaction("handles").objectStore("handles").get("output-directory");
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}
async function refreshSelectedFolder() {
  try {
    const handle = await getDirectoryHandle();
    $("selected-folder").textContent = handle?.name || "Ninguna carpeta seleccionada";
    $("selected-folder").title = handle?.name || "";
  } catch {
    $("selected-folder").textContent = "No se pudo recuperar la carpeta";
  }
}

$("choose-folder").addEventListener("click", async () => {
  try {
    if (!window.showDirectoryPicker) throw new Error("Este Chrome no ofrece el selector de carpetas.");
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    let permission = await handle.queryPermission({ mode: "readwrite" });
    if (permission !== "granted") permission = await handle.requestPermission({ mode: "readwrite" });
    if (permission !== "granted") throw new Error("Chrome no concedió permiso de escritura para esa carpeta.");
    const previousHandle = await getDirectoryHandle();
    const sameFolder = previousHandle ? await previousHandle.isSameEntry(handle) : false;
    selectedDirectoryHandle = handle;
    await saveDirectoryHandle(handle);
    if (!sameFolder) await chrome.storage.local.set({ flowDownloadNextNumber: 1 });
    await refreshSelectedFolder();
    state.message = `Carpeta ${handle.name} guardada para las próximas sesiones.`;
    state.error = false;
    await saveDownloadSettings();
    render();
  } catch (error) {
    if (error.name !== "AbortError") {
      state.message = error.message || "No pude guardar la carpeta seleccionada.";
      state.error = true;
      render();
    }
  }
});

$("auto-download").addEventListener("change", async () => {
  if ($("auto-download").checked) {
    const origins = ["https://flow-content.google/*", "https://*.googleusercontent.com/*", "https://*.googlevideo.com/*", "https://storage.googleapis.com/*"];
    let granted = await chrome.permissions.contains({ origins });
    if (!granted) granted = await chrome.permissions.request({ origins });
    if (!granted) {
      $("auto-download").checked = false;
      state.message = "Chrome no concedió acceso a los servidores de archivos de Flow; la cola seguirá sin guardar resultados automáticamente.";
      await save();
      return;
    }
  }
  await saveDownloadSettings();
});
$("download-prefix").addEventListener("change", saveDownloadSettings);
elements.input.addEventListener("input", () => { draftPrompts = parsePrompts(elements.input.value); render(); });
elements.queue.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const item = state.items.find((entry) => entry.id === button.dataset.id);
  if (!item || state.running) return;
  if (button.dataset.action === "save-output") {
    try {
      const result = await writeFlowOutput(item.unsavedOutput);
      delete item.unsavedOutput;
      await chrome.storage.local.set({ flowDownloadNextNumber: Number(result.number) + 1 });
      state.message = `Guardado: ${result.filename}`; state.error = false;
    } catch (error) { state.message = error.message; state.error = true; }
    await save(); return;
  }
  if (button.dataset.action === "mark-done") item.status = "done";
  else if (button.dataset.action === "retry") item.status = "pending";
  state.message = button.dataset.action === "mark-done" ? "Prompt marcado como generado." : "Prompt devuelto a pendientes.";
  state.error = false;
  await save();
});

elements.add.addEventListener("click", async () => {
  if (!draftPrompts.length) return;
  state.items.push(...draftPrompts.map((prompt) => ({ id: crypto.randomUUID(), prompt, status: "pending" })));
  draftPrompts = []; elements.input.value = "";
  state.message = state.running ? "Prompts añadidos al final de la cola." : `${state.items.filter((i) => i.status === "pending").length} prompts pendientes. Inicia la cola cuando quieras.`;
  await save();
});
$("discard").addEventListener("click", () => { draftPrompts = []; elements.input.value = ""; render(); });
$("start").addEventListener("click", async () => {
  if (!state.items.some((i) => i.status === "pending")) return;
  const config = await chrome.storage.local.get("flowDownloadSettings");
  if (config.flowDownloadSettings?.enabled) {
    const handle = await getDirectoryHandle();
    if (!handle) {
      state.message = "El guardado automático está activo. Elige primero la carpeta de destino.";
      state.error = true; render(); return;
    }
    const permission = await handle.queryPermission({ mode: "readwrite" });
    if (permission !== "granted") {
      state.message = "Chrome requiere permiso de escritura. Pulsa Elegir carpeta y selecciona la carpeta guardada otra vez.";
      state.error = true; render(); return;
    }
  }
  const reply = await chrome.runtime.sendMessage({ type: "FLOW_QUEUE_COMMAND", command: { type: "START_QUEUE" } });
  if (!reply?.ok) { state.message = reply?.error || "No se pudo iniciar la cola."; state.error = true; await save(); return; }
  state.running = true; state.paused = false; state.error = false; state.message = "Conectando con Flow…"; await save();
});
elements.pause.addEventListener("click", async () => {
  const type = state.paused ? "RESUME_QUEUE" : "PAUSE_QUEUE";
  const reply = await chrome.runtime.sendMessage({ type: "FLOW_QUEUE_COMMAND", command: { type } });
  if (reply?.ok) { state.paused = type === "PAUSE_QUEUE"; state.message = state.paused ? "En pausa. El prompt actual terminará antes de detenerse." : "Cola reanudada."; await save(); }
});
elements.stop.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "FLOW_QUEUE_COMMAND", command: { type: "STOP_QUEUE" } });
  state.message = "Deteniendo al terminar el prompt actual…"; await save();
});
$("clear").addEventListener("click", async () => { if (!state.running) { state.items = []; state.message = "Cola limpiada."; await save(); } });
chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes.flowQueue) { state = { ...state, ...changes.flowQueue.newValue }; render(); } });
load();

async function writeFlowOutput(message) {
  const handle = await getDirectoryHandle();
  if (!handle) throw new Error("Elige primero una carpeta de destino.");
  if (await handle.queryPermission({ mode: "readwrite" }) !== "granted") {
    throw new Error("Chrome requiere permiso de escritura. Pulsa Elegir carpeta y selecciona la carpeta guardada otra vez.");
  }

  const url = String(message.url || "");
  if (!/^https?:/i.test(url)) throw new Error("Flow no expuso un enlace descargable para este resultado.");
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error(`Flow respondió ${response.status} al descargar el resultado.`);
  const blob = await response.blob();
  const mime = (blob.type || message.mime || "application/octet-stream").split(";")[0].toLowerCase();
  const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "video/webm": "webm" })[mime]
    || url.split(/[?#]/)[0].match(/\.([a-z0-9]{1,8})$/i)?.[1]
    || "bin";
  const rawPrefix = String(message.prefix || "stick").trim() || "stick";
  const prefix = rawPrefix.replace(/[<>:"\/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").slice(0, 60) || "stick";
  const folderName = prefix.charAt(0).toUpperCase() + prefix.slice(1);
  const outputFolder = await handle.getDirectoryHandle(folderName, { create: true });
  let number = Number(message.number) || 1;
  let filename = `${prefix}${number}.${extension}`;
  while (true) {
    try {
      await outputFolder.getFileHandle(filename);
      number += 1;
      filename = `${prefix}${number}.${extension}`;
    } catch (error) {
      if (error.name === "NotFoundError") break;
      throw error;
    }
  }

  const file = await outputFolder.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  await writable.write(blob);
  await writable.close();
  return { ok: true, filename: `${handle.name}/${folderName}/${filename}`, number };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "WRITE_FLOW_OUTPUT_PANEL" || sender.id !== chrome.runtime.id || sender.tab) return;
  void writeFlowOutput(message.output).then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: error.message || String(error) });
  });
  return true;
});
