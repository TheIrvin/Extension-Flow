chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "FLOW_REAL_CLICK") {
    void dispatchFlowClick(message, sender).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: `Chrome no pudo hacer clic en Flow: ${error.message || error}` });
    });
    return true;
  }
  if (message?.type === "FLOW_WRITE_OUTPUT") {
    void saveOutputToSelectedFolder(message, sender).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message || String(error) });
    });
    return true;
  }
  if (message?.type === "FLOW_QUEUE_COMMAND") {
    void handleQueueCommand(message, sender).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message || String(error) });
    });
    return true;
  }
  if (message?.type === "FLOW_QUEUE_FINISH") {
    void detachQueueDebugger(sender.tab?.id).then(() => sendResponse({ ok: true }));
    return true;
  }
});

const SESSION_TAB_KEY = "flowQueueDebuggerTabId";
const isFlowUrl = (value) => {
  let host = "";
  try { host = new URL(value || "").hostname; } catch {}
  return host === "labs.google" || host.endsWith(".labs.google") || host === "flow.google" || host === "flow.google.com" || host.endsWith(".flow.google.com");
};

async function getQueueDebuggerTabId() {
  const saved = await chrome.storage.session.get(SESSION_TAB_KEY);
  return saved[SESSION_TAB_KEY];
}

async function attachQueueDebugger(tabId) {
  if (!await chrome.permissions.contains({ permissions: ["debugger"] })) {
    throw new Error("Chrome no tiene habilitado el permiso Depurador para la cola de Flow.");
  }
  const targets = await chrome.debugger.getTargets();
  const attachedTarget = targets.find((target) => target.tabId === tabId);
  if (await getQueueDebuggerTabId() === tabId && attachedTarget?.attached) return;
  if (await getQueueDebuggerTabId() === tabId) await chrome.storage.session.remove(SESSION_TAB_KEY);
  if (attachedTarget?.attached) {
    throw new Error("Flow ya tiene otra sesión de depuración conectada. Cierra DevTools de esa pestaña y vuelve a iniciar la cola.");
  }
  await chrome.debugger.attach({ tabId }, "1.3");
  await chrome.storage.session.set({ [SESSION_TAB_KEY]: tabId });
}

async function detachQueueDebugger(tabId) {
  const attachedTabId = await getQueueDebuggerTabId();
  if (attachedTabId == null || (tabId != null && attachedTabId !== tabId)) return;
  try { await chrome.debugger.detach({ tabId: attachedTabId }); } catch {}
  await chrome.storage.session.remove(SESSION_TAB_KEY);
}

chrome.debugger.onDetach.addListener((source) => {
  void getQueueDebuggerTabId().then((tabId) => {
    if (tabId === source.tabId) return chrome.storage.session.remove(SESSION_TAB_KEY);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") void detachQueueDebugger(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => { void detachQueueDebugger(tabId); });

async function ensureOutputDocument() {
  const url = chrome.runtime.getURL("offscreen.html");
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
  if (!contexts.length) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "Guardar directamente los resultados de Flow en la carpeta elegida por el usuario."
    });
  }
}

async function saveOutputToSelectedFolder(message, sender) {
  if (!sender.tab?.id || !isFlowUrl(sender.tab.url)) throw new Error("Solo guardo resultados enviados desde una pestaña de Flow.");
  const url = String(message.url || "");
  let host = "";
  try { host = new URL(url).hostname; } catch {}
  const allowedHost = new URL(url).protocol === "https:" && (host === "flow-content.google" || isFlowUrl(url) || host.endsWith(".googleusercontent.com") || host.endsWith(".googlevideo.com") || host === "storage.googleapis.com");
  if (!allowedHost) throw new Error(`El resultado no proviene de un servidor multimedia permitido de Google (${host || "URL inválida"}).`);
  const origins = ["https://flow-content.google/*", "https://*.googleusercontent.com/*", "https://*.googlevideo.com/*", "https://storage.googleapis.com/*"];
  const grantedOrigins = await chrome.permissions.contains({ origins });
  if (!grantedOrigins) throw new Error("Activa el permiso opcional para los servidores multimedia de Google en la casilla de descarga automática.");
  const result = await chrome.runtime.sendMessage({ type: "WRITE_FLOW_OUTPUT_PANEL", output: message });
  if (!result?.ok) throw new Error(result?.error || "Mantén abierto el panel de la extensión para guardar resultados.");
  return result;
}

async function handleQueueCommand(message, sender) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const queueTabId = await getQueueDebuggerTabId();
  let queueTab;
  if (queueTabId != null && message.command?.type !== "START_QUEUE") {
    try { queueTab = await chrome.tabs.get(queueTabId); } catch {}
  }
  const tab = queueTab || (sender.tab?.id ? sender.tab : tabs[0]);
  if (!tab?.id || !isFlowUrl(tab.url)) {
    return { ok: false, error: "No reconocí Google Flow en la pestaña asociada al panel. Recarga la pestaña de Flow y vuelve a intentarlo." };
  }

  const starting = message.command?.type === "START_QUEUE";
  if (starting) await attachQueueDebugger(tab.id);
  const response = await new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, message.command, (result) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: "No pude conectar con Flow. Recarga la pestaña y vuelve a intentarlo." });
      else resolve(result || { ok: true });
    });
  });
  if (starting && !response.ok) await detachQueueDebugger(tab.id);
  return response;
}

async function dispatchFlowClick(message, sender) {
  const tabId = sender.tab?.id;
  const isFlow = isFlowUrl(sender.tab?.url);
  if (!tabId || !isFlow) return { ok: false, error: "El clic avanzado solo está permitido en una pestaña de Google Flow." };
  if (!await chrome.permissions.contains({ permissions: ["debugger"] })) {
    return { ok: false, needsPermission: true, error: "Activa primero el clic avanzado de Chrome desde el panel." };
  }
  const x = Number(message.x), y = Number(message.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return { ok: false, error: "No pude determinar la posición del botón de Flow." };
  const target = { tabId };
  let attachedForClick = false;
  try {
    const queueTabId = await getQueueDebuggerTabId();
    if (queueTabId !== tabId) {
      await chrome.debugger.attach(target, "1.3");
      attachedForClick = true;
    }
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    return { ok: true };
  } finally {
    if (attachedForClick) await chrome.debugger.detach(target).catch(() => {});
  }
}
