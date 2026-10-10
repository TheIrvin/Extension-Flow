(() => {
  if (window.__flowPromptQueueInstalled) return;
  window.__flowPromptQueueInstalled = true;
  let active = false, paused = false, stopRequested = false;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalize = (s) => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const isVisible = (el) => !!(el && el.isConnected && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const textOf = (el) => normalize(`${el.innerText || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("placeholder") || ""} ${el.getAttribute("data-placeholder") || ""}`);

  function findComposer() {
    const all = [...document.querySelectorAll('textarea,input:not([type="file"]),[contenteditable],[role="textbox"],[data-placeholder]')].filter(isVisible);
    const promptHint = /prompt|describe|escribe|que quieres|what do you want/;
    const hinted = all.find((el) => promptHint.test(textOf(el)) || promptHint.test(textOf(el.parentElement)));
    const editableSelector = 'textarea,input:not([type="file"]),[contenteditable],[role="textbox"]';
    const hintedEditor = hinted?.matches(editableSelector) ? hinted : hinted?.closest(editableSelector);
    return hintedEditor
      || all.find((el) => (el.matches('[contenteditable],[role="textbox"]') || el.isContentEditable) && !/search|buscar/.test(textOf(el)))
      || all.find((el) => el.tagName === "TEXTAREA");
  }
  function findGenerateButton() {
    const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(isVisible);
    return buttons.find((el) => /^(generate|generar|iniciar generacion|start generation|crear (?:imagen|video)|create (?:image|video)|generate video|generar video)$/.test(textOf(el)))
      || buttons.find((el) => /generate|generar|generacion/.test(textOf(el)) && !/tool|collection|project|configuracion|ajustes/.test(textOf(el)));
  }
  function isBusy() {
    const busy = document.querySelectorAll('[aria-busy="true"],[role="progressbar"],[data-state="loading"]');
    if ([...busy].some(isVisible)) return true;
    const body = normalize(document.body?.innerText || "");
    return /generating|generation in progress|creating image|generando|creando imagen|\b(?:100|[1-9]?\d)\s*%/.test(body);
  }
  const tileSelector = "flow-grid-tile-container";
  const tiles = () => [...document.querySelectorAll(tileSelector)];
  function assetKey(value) {
    try { const url = new URL(value); return `${url.origin}${url.pathname}`; }
    catch { return value || ""; }
  }
  function generatedMediaEntries() {
    const root = document.querySelector("#main-content,[role='main'],main") || document.body;
    const result = [];
    const seen = new Set();
    for (const media of root.querySelectorAll("img,video")) {
      // A lazy thumbnail need not have decoded yet for its Google asset URL to
      // be downloadable. Do not gate saving on naturalWidth/video.readyState.
      const url = media.currentSrc || media.getAttribute("src") || media.querySelector("source[src]")?.src;
      const tile = media.closest(tileSelector);
      if (!tile || !url) continue;
      let downloadable = false;
      try {
        const parsed = new URL(url);
        downloadable = parsed.protocol === "https:" && (parsed.hostname === "flow-content.google" || parsed.hostname.endsWith(".googleusercontent.com") || parsed.hostname.endsWith(".googlevideo.com") || parsed.hostname === "storage.googleapis.com");
      } catch {}
      const ready = downloadable || (media instanceof HTMLImageElement
        ? media.complete && media.naturalWidth > 100 && media.naturalHeight > 100
        : media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && media.videoWidth > 100 && media.videoHeight > 100);
      const signature = assetKey(url);
      if (ready && !seen.has(signature)) {
        seen.add(signature);
        result.push({ element: media, tile, signature, url });
      }
    }
    return result;
  }
  function generationSnapshot() {
    return { nodes: new Set(tiles()), labels: new Set(tiles().map(t => t.getAttribute("aria-label")).filter(Boolean)), assets: new Set(generatedMediaEntries().map(e => e.signature)) };
  }
  async function waitUntilIdle() {
    
    const start = Date.now();
    while (Date.now() - start < 25 * 60 * 1000) {
      if (stopRequested) return false;
      // El botón puede estar deshabilitado porque todavía no hemos escrito el prompt.
      if (!isBusy()) return true;
      await sleep(500);
    }
    throw new Error("Flow sigue ocupado después de 25 minutos. No se envió el siguiente prompt; revisa la pestaña y vuelve a iniciar.");
  }
  async function waitForEnabledGenerate() {
    const start = Date.now();
    while (Date.now() - start < 10000) {
      if (stopRequested) return null;
      const button = findGenerateButton();
      if (button && !button.disabled && button.getAttribute("aria-disabled") !== "true") return button;
      await sleep(150);
    }
    return null;
  }
  async function update(patch) {
    const stored = await chrome.storage.local.get("flowQueue");
    const queue = stored.flowQueue || { items: [] };
    Object.assign(queue, patch);
    await chrome.storage.local.set({ flowQueue: queue });
  }
  async function waitIfPaused() { while (paused && !stopRequested) await sleep(300); }
  function fillComposer(el, value) {
    el.focus();
    if (el.isContentEditable || el.hasAttribute("contenteditable") || el.getAttribute("role") === "textbox") {
      document.execCommand("selectAll", false);
      document.execCommand("insertText", false, value);
      if ((el.innerText || el.textContent || "").trim() !== value.trim()) throw new Error("Flow no aceptó el texto en su editor.");
    } else {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
      if (setter) setter.call(el, value); else el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      if (el.value !== value) throw new Error("Flow no aceptó el texto en su editor.");
    }
  }
  function composerText(el) { return ("value" in el ? el.value : el.innerText || el.textContent || "").trim(); }
  async function clickGenerate(button) {
    const rect = button.getBoundingClientRect();
    if (rect.width && rect.height) {
      const result = await chrome.runtime.sendMessage({
        type: "FLOW_REAL_CLICK",
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      });
      if (result?.ok) return "chrome";
    }
    try { button.focus({ preventScroll: true }); } catch { button.focus(); }
    button.click();
    return "dom";
  }
  async function waitForSubmission(button, composer, prompt) {
    const start = Date.now();
    const beforeLabel = textOf(button);
    const beforeEmptyState = normalize(document.body?.innerText || "").includes("comienza a crear o suelta contenido multimedia");
    while (Date.now() - start < 45000) {
      if (stopRequested) return "stopped";
      const currentButton = findGenerateButton();
      const currentComposer = findComposer() || composer;
      const labelChanged = currentButton && textOf(currentButton) !== beforeLabel;
      const emptyStateChanged = beforeEmptyState && !normalize(document.body?.innerText || "").includes("comienza a crear o suelta contenido multimedia");
      if (isBusy() || currentButton?.disabled || labelChanged || composerText(currentComposer) !== prompt.trim() || emptyStateChanged) return "started";
      await sleep(700);
    }
    return "not-started";
  }
  async function waitForGeneration(before) {
    const start = Date.now();
    let stableSince = 0, stableKey = "";
    const trackedTiles = new Set();
    while (Date.now() - start < 25 * 60 * 1000) {
      if (stopRequested) return { outcome: "stopped", outputs: [] };
      for (const tile of tiles()) {
        const label = tile.getAttribute("aria-label");
        if (!before.nodes.has(tile) && !(label && before.labels.has(label))) trackedTiles.add(tile);
      }
      const outputs = generatedMediaEntries().filter(e => trackedTiles.has(e.tile) && !before.assets.has(e.signature));
      const key = outputs.map(e => e.signature).sort().join("\n");
      // A percentage (including 99%/100%) or spinner always prevents completion.
      if (isBusy() || !key) { stableSince = 0; stableKey = ""; }
      else {
        if (key !== stableKey) { stableKey = key; stableSince = Date.now(); }
        if (Date.now() - stableSince >= 750) {
          // This queue deliberately accepts one result per prompt. Ambiguity stops it.
          if (outputs.length !== 1) return { outcome: "unconfirmed", outputs: [] };
          return { outcome: "done", outputs: outputs.map(e => ({ url: e.url, signature: e.signature, mime: e.element instanceof HTMLVideoElement ? "video/mp4" : "image/png" })) };
        }
      }
      await sleep(500);
    }
    return { outcome: "timeout", outputs: [] };
  }
  async function runQueue() {
    if (active) return;
    active = true; stopRequested = false;
    try {
      await update({ running: true, paused: false, error: false, message: "Cola iniciada. Esperando que Flow esté listo…" });
      while (!stopRequested) {
        await waitIfPaused();
        if (stopRequested) break;
        const saved = await chrome.storage.local.get("flowQueue");
        const queue = saved.flowQueue || { items: [] };
        const item = queue.items.find((entry) => entry.status === "pending");
        if (!item) { await update({ running: false, paused: false, message: "Cola completada." }); break; }
        const composer = findComposer(), button = findGenerateButton();
        if (!composer || !button) {
          // No generation was submitted, so keep this prompt at the head of the queue.
          item.status = "pending";
          queue.running = false; queue.error = true;
          queue.message = !composer
            ? "No encontré el cuadro de prompt de Flow. Recarga Flow y vuelve a iniciar la cola."
            : "No encontré el botón de generación de Flow. Recarga Flow y vuelve a iniciar la cola.";
          await chrome.storage.local.set({ flowQueue: queue }); break;
        }
        await update({ message: "Esperando que no haya generaciones pendientes en Flow…" });
        if (!await waitUntilIdle()) break;
        const mediaBefore = generationSnapshot();
        item.status = "running";
        queue.message = `Enviando ${queue.items.indexOf(item) + 1} de ${queue.items.length}…`;
        queue.error = false;
        await chrome.storage.local.set({ flowQueue: queue });
        try {
          fillComposer(findComposer() || composer, item.prompt);
        } catch (error) {
          item.status = "pending"; queue.running = false; queue.error = true;
          queue.message = `No pude escribir en el cuadro de Flow: ${error.message || error}. El prompt quedó pendiente.`;
          await chrome.storage.local.set({ flowQueue: queue }); break;
        }
        const currentButton = await waitForEnabledGenerate();
        if (!currentButton) {
          item.status = "pending"; queue.running = false; queue.error = true;
          queue.message = stopRequested
            ? "Cola detenida antes del envío. El prompt quedó pendiente."
            : "Flow no habilitó Generar en 10 segundos después de escribir. Revisa modo Imagen, créditos o avisos de Flow. El prompt quedó pendiente.";
          await chrome.storage.local.set({ flowQueue: queue }); break;
        }
        await update({ message: `Preparando ${queue.items.indexOf(item) + 1} de ${queue.items.length}. Si Flow no inicia, pulsa su flecha de generación.` });
        await clickGenerate(currentButton);
        const submission = await waitForSubmission(currentButton, composer, item.prompt);
        if (submission !== "started") {
          item.status = "pending"; queue.running = false; queue.error = submission !== "stopped";
          queue.message = submission === "stopped"
            ? "Cola detenida antes de confirmar el envío. El prompt quedó pendiente."
            : "Flow no confirmó el clic. El prompt quedó pendiente; recarga Flow y, si la flecha sigue activa, púlsala manualmente.";
          await chrome.storage.local.set({ flowQueue: queue }); break;
        }
        await update({ message: `Generando ${queue.items.indexOf(item) + 1} de ${queue.items.length}… Esperando el resultado de Flow.` });
        const generation = await waitForGeneration(mediaBefore);
        const outcome = generation.outcome;
        let downloadFailure = "";
        const savedFiles = [];
        if (outcome === "done") {
          const savedSettings = await chrome.storage.local.get(["flowDownloadSettings", "flowDownloadNextNumber"]);
          const settings = savedSettings.flowDownloadSettings || {};
          if (settings.enabled) {
            const outputs = generation.outputs;
            let number = Number(savedSettings.flowDownloadNextNumber) || 1;
            if (!outputs.length) downloadFailure = "Flow mostró el resultado, pero no pude localizar el asset para descargarlo.";
            for (const output of outputs) {
              if (downloadFailure) break;
              const outputRequest = {
                type: "FLOW_WRITE_OUTPUT",
                requestId: crypto.randomUUID(),
                url: output.url,
                mime: output.mime,
                prefix: settings.prefix || "stick",
                number
              };
              item.unsavedOutput = outputRequest;
              await chrome.storage.local.set({ flowQueue: queue });
              let result;
              for (let attempt = 1; attempt <= 3; attempt++) {
                try { result = await chrome.runtime.sendMessage(outputRequest); break; }
                catch (error) {
                  if (attempt === 3) result = { ok: false, error: error.message || String(error) };
                  else await sleep(250 * attempt);
                }
              }
              if (!result?.ok) { item.unsavedOutput = outputRequest; downloadFailure = result?.error || "No pude descargar el resultado de Flow."; break; }
              delete item.unsavedOutput;
              if (result.filename) savedFiles.push(result.filename);
              number = (Number(result.number) || number) + 1;
              await chrome.storage.local.set({ flowDownloadNextNumber: number });
            }
          }
        }
        if (outcome === "timeout" || outcome === "unconfirmed") { item.status = "error"; queue.error = true; }
        else if (outcome === "stopped") item.status = "pending";
        else item.status = "done";
        queue.running = outcome === "done" && !downloadFailure; queue.paused = false;
        queue.error = queue.error || Boolean(downloadFailure);
        if (downloadFailure) queue.message = `Prompt ${queue.items.indexOf(item) + 1} generado, pero falló el guardado: ${downloadFailure}. El resultado sigue en Flow y la cola se detuvo.`;
        else if (outcome === "timeout") queue.message = "Flow no mostró una imagen o video nuevo en 25 minutos. Revisa el resultado antes de marcarlo listo o reintentar.";
        else if (outcome === "unconfirmed") queue.message = "No pude asociar un único resultado al prompt actual. Usa x1 y evita generar manualmente mientras funciona la cola; revisa Flow antes de continuar.";
        else if (outcome === "stopped" || stopRequested) queue.message = "Cola detenida. El prompt quedó pendiente si Flow no había confirmado el envío.";
        else queue.message = savedFiles.length
          ? `Prompt ${queue.items.indexOf(item) + 1} de ${queue.items.length} completado y guardado: ${savedFiles.join(", ")}`
          : `Prompt ${queue.items.indexOf(item) + 1} de ${queue.items.length} completado.`;
        await chrome.storage.local.set({ flowQueue: queue });
        if (outcome !== "done" || downloadFailure) break;
        // El guardado ya terminó: pasar al siguiente sin enfriamiento artificial.
      }
      if (stopRequested) await update({ running: false, paused: false, message: "Cola detenida. Los prompts pendientes se conservaron." });
    } catch (error) {
      await update({ running: false, paused: false, error: true, message: `Error en la cola: ${error.message || error}` });
    } finally {
      active = false; paused = false;
      chrome.runtime.sendMessage({ type: "FLOW_QUEUE_FINISH" }).catch(() => {});
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "GET_QUEUE_STATUS") { sendResponse({ ok: true, active, paused }); }
    else if (message?.type === "START_QUEUE") { if (!active) void runQueue(); sendResponse({ ok: true }); }
    else if (message?.type === "PAUSE_QUEUE") { paused = true; sendResponse({ ok: true }); }
    else if (message?.type === "RESUME_QUEUE") { paused = false; sendResponse({ ok: true }); }
    else if (message?.type === "STOP_QUEUE") { stopRequested = true; paused = false; sendResponse({ ok: true }); }
  });
})();
