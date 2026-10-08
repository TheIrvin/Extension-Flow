const folderDb = new Promise((resolve, reject) => {
  const request = indexedDB.open("flow-prompt-queue-files", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("handles");
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function getDirectoryHandle() {
  const db = await folderDb;
  return new Promise((resolve, reject) => {
    const request = db.transaction("handles").objectStore("handles").get("output-directory");
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "WRITE_FLOW_OUTPUT_INTERNAL") return;
  void writeFlowOutput(message.output).then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: error.message || String(error) });
  });
  return true;
});
