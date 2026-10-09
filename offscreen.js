// Este documento oculto solo usa chrome.runtime; los datos persistentes viven en IndexedDB.
const folderDb = new Promise((resolve, reject) => {
  const request = indexedDB.open("flow-prompt-queue-files", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("handles");
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
async function readValue(key) {
  const db = await folderDb;
  return new Promise((resolve, reject) => {
    const request = db.transaction("handles").objectStore("handles").get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}
async function writeValue(key, value) {
  const db = await folderDb;
  await new Promise((resolve, reject) => {
    const tx = db.transaction("handles", "readwrite");
    tx.objectStore("handles").put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("No se pudo conservar el estado del guardado."));
  });
}
async function deleteValue(key) {
  const db = await folderDb;
  await new Promise((resolve, reject) => {
    const tx = db.transaction("handles", "readwrite");
    tx.objectStore("handles").delete(key);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}
async function getDirectoryHandle() { return readValue("output-directory"); }
async function checkDestination() {
  const handle = await getDirectoryHandle();
  if (!handle) throw new Error("Elige primero una carpeta de destino.");
  if (await handle.queryPermission({ mode: "readwrite" }) !== "granted") {
    throw new Error("Abre el panel y pulsa Autorizar carpeta para permitir el guardado en segundo plano.");
  }
  // Comprobar acceso real a la carpeta, sin crear archivos de prueba.
  for await (const entry of handle.values()) { break; }
  return { ok: true, folder: handle.name };
}

async function writeFlowOutput(message) {
  const requestId = message.requestId ||= crypto.randomUUID();
  return navigator.locks.request("flow-output-writer", async () => {
    const receipt = await readValue(`receipt:${requestId}`);
    if (receipt) return receipt;
    let blob, outputFolder, file, filename, number, result;
    const handle = await getDirectoryHandle();
    if (!handle) throw new Error("Elige primero una carpeta de destino.");
    const jobKey = `save-job:${requestId}`;
    const job = await readValue(jobKey);
    if (job && await job.rootHandle.isSameEntry(handle).catch(() => false)) {
      ({ blob, outputFolder, file, filename, number, result } = job);
    }
    const url = String(message.url || "");
    if (!/^https?:/i.test(url)) throw new Error("Flow no expuso un enlace descargable para este resultado.");
    for (let attempt = 1; attempt <= 3; attempt++) {
      let writable;
      try {
        if (await handle.queryPermission({ mode: "readwrite" }) !== "granted") {
          const error = new Error("Chrome requiere permiso de escritura. Pulsa Autorizar carpeta; no necesitas volver a seleccionarla.");
          error.name = "NotAllowedError"; throw error;
        }
        if (!blob) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 60000);
          try {
            const response = await fetch(url, { credentials: "include", signal: controller.signal });
            if (!response.ok) throw new Error(`Flow respondió ${response.status} al descargar el resultado.`);
            blob = await response.blob();
            if (!blob.size) { blob = null; throw new Error("Flow devolvió un archivo vacío."); }
            if (!/^(image|video)\//i.test(blob.type || message.mime || "")) {
              blob = null; throw new Error("Flow no devolvió una imagen o video válido.");
            }
          } finally { clearTimeout(timer); }
        }
        if (!result) {
          const prefix = (String(message.prefix || "stick").trim().replace(/[<>:"\/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").slice(0, 60)) || "stick";
          const folderName = prefix.charAt(0).toUpperCase() + prefix.slice(1);
          outputFolder = await handle.getDirectoryHandle(folderName, { create: true });
          const mime = (blob.type || message.mime).split(";")[0].toLowerCase();
          const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "video/webm": "webm" })[mime] || "bin";
          number = Number(message.number) || 1;
          while (true) {
            filename = `${prefix}${number}.${extension}`;
            try { await outputFolder.getFileHandle(filename); number++; }
            catch (error) { if (error.name === "NotFoundError") break; throw error; }
          }
          result = { ok: true, filename: `${handle.name}/${folderName}/${filename}`, number };
        }
        // Conservar el mismo destino y blob entre intentos; no crear una imagen numerada extra.
        file ||= await outputFolder.getFileHandle(filename, { create: true });
        // Conservar la reserva y el archivo descargado si el documento se reinicia.
        await writeValue(jobKey, { rootHandle: handle, blob, outputFolder, file, filename, number, result });
        writable = await file.createWritable();
        await writable.write(blob);
        await writable.close();
        writable = null;
        await writeValue(`receipt:${requestId}`, result);
        await deleteValue(jobKey).catch(() => {});
        return result;
      } catch (error) {
        if (writable) await writable.abort().catch(() => {});
        if (error.name === "NotAllowedError" || error.name === "SecurityError" || attempt === 3) {
          throw new Error(`${error.message || error}${attempt === 3 ? " (3 intentos de guardado agotados)." : ""}`);
        }
        await chrome.runtime.sendMessage({ type: "FLOW_SAVE_PROGRESS", requestId, message: `Guardado fallido. Reintentando ${attempt + 1}/3 sin volver a generar…` }).catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 300 * attempt));
      }
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.tab || message?.target !== "flow-file-writer") return;
  let operation;
  if (message.type === "WRITE_FLOW_OUTPUT_INTERNAL") operation = () => writeFlowOutput(message.output);
  else if (message.type === "CHECK_FLOW_DESTINATION_INTERNAL") operation = checkDestination;
  else return;
  void operation().then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});
