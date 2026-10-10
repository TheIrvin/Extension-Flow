# Extension Flow

A local Google Chrome extension that queues prompts in Google Flow and optionally saves generated images or videos to a folder you choose. It runs through Flow's visible interface; no API key, build step, or dependency installation is required.

## Requirements

- A current desktop version of Google Chrome with side panel and directory picker support.
- Access to Google Flow, an open project, and sufficient generation credits.
- Flow configured for the desired image or video model, **one output per prompt (x1)**, and your preferred settings.

The extension interface currently uses Spanish labels. Their English equivalents are provided below.

## Install and run

1. Clone this repository, or download its ZIP from **Code → Download ZIP** and extract it.

   ```sh
   git clone https://github.com/TheIrvin/Extension-Flow.git
   ```

2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the folder containing `manifest.json`.
4. Open a Google Flow project in Chrome. Select Image or Video mode, choose your model and settings, and set the output count to **x1**. Let existing generations finish before starting the queue.
5. Click the extension's toolbar icon to open its side panel.
6. Paste your prompts, review the compact previews, and click **Añadir prompts a la cola** (Add prompts to queue).
7. Optionally configure automatic saving as described below.
8. Click **Iniciar cola** (Start queue). Keep the Flow tab open while processing. You can switch tabs or close the side panel; saving runs in a hidden extension document. Keep Chrome running.

Chrome displays a debugger notification while the extension uses browser-assisted clicks. Avoid opening DevTools on the same Flow tab during a queue run.

## Prompt format

Use numbered headings. Each prompt can contain multiple lines; continuation lines belong to the current prompt until the next heading.

```text
prompt1: A traveler discovering a floating city.

prompt2: The traveler crossing a crystal bridge.

prompt3: A mysterious door opening beneath the city.
```

`prompt 1:` also works. Without numbered headings, separate prompts with an empty line. Preview and queue entries show short excerpts; click an entry's disclosure arrow to read the full prompt. The complete text is still sent to Flow.

## How the queue works

1. Waits only while Flow is generating; an empty composer with a disabled Generate button does not block prompt entry. No fixed idle cooldown.
2. Writes the prompt into the visible composer, waits up to 10 seconds for Generate to become enabled, and clicks it through Chrome's debugger, with a DOM click fallback. If it stays disabled, the prompt remains pending with an explanatory message.
3. Watches new Flow result cards rather than treating changes in image display size as new results. Media identity excludes temporary URL query parameters.
4. Waits for a loaded image or playable video. Visible loading indicators and percentages, including 99%, prevent completion. The result must remain stable without a detected loading indicator for 750 milliseconds.
5. Accepts a single unambiguous result, optionally saves it, then immediately proceeds to the next prompt. Multiple detected outputs stop the queue for review; use x1.

The generation timeout is 25 minutes. Detection depends on Flow's current page structure, so Google interface changes can require an extension update. Do not submit manual generations during a queue run: unrelated new cards can make result attribution ambiguous. The queue does not configure Flow's model, aspect ratio, or other generation settings.

## Controls

| Panel label | Action |
| --- | --- |
| Iniciar cola | Start processing pending prompts. |
| Pausar / Continuar | Pause after the current prompt or resume processing. |
| Detener | Stop queue processing; an already submitted Flow generation may continue on Google's side. |
| Vaciar borrador | Clear the input and draft previews. |
| Limpiar cola | Clear queue entries when processing is stopped. |
| Marcar listo | Mark an interrupted or uncertain generation as completed after inspecting Flow. |
| Reintentar | Return an uncertain entry to pending; this can generate it again and consume credits. |
| Guardar imagen | Retry saving a retained failed output without submitting a new generation. |

Queue entries and progress are stored locally in Chrome. If a run is interrupted, inspect Flow before retrying to avoid generating duplicates.

## Automatic saving

1. Enable **Descargar automáticamente cada resultado** (Automatically download each result).
2. Accept the optional access request for Google's media servers.
3. Set **Nombre base** (Base name), for example `story`.
4. Click **Elegir carpeta…** (Choose folder), select a destination, and allow writing.

The extension creates a subfolder with the first character of the base name capitalized and numbers files sequentially:

```text
SelectedFolder/
  Story/
    story1.png
    story2.jpg
    story3.webp
```

The extension preserves the downloaded format rather than converting it. Existing filenames are skipped to avoid overwriting files. Numbering restarts when the base name or destination changes, while collisions are still avoided.

Saving runs in an offscreen extension document, using the destination authorized in the side panel. Changing tabs or closing/reopening the panel does not stop file writing. Reopening the panel queries the live queue before marking anything interrupted. Destination access is checked before starting generation. Keep the Flow tab and Chrome open; closing the browser, reloading Flow or reloading the extension interrupts the queue. If Chrome expires permission, starting requests access to the saved folder; Autorizar carpeta also restores access without choosing it again. Only moved or deleted folders need reselection. Saving retries up to three times, reusing the downloaded data and destination; a successful retry continues the queue. Exhausted retries stop the queue while leaving the generated result in Flow. When its output link has been retained, **Guardar imagen** retries the download; an expired link may require downloading directly from Flow.

## Updating

Pull the latest changes, or replace your extracted copy with the latest download. Click **Reload** for this extension at `chrome://extensions`, then reload the Flow tab and reopen the panel. Re-select the destination folder if Chrome requests write access again.

## Permissions and privacy

- **storage:** saves queue progress, download preferences, and numbering locally.
- **sidePanel:** displays the queue controls.
- **tabs:** identifies the Flow tab associated with queue commands.
- **debugger:** sends browser-level clicks to Flow; the connection is released when the run finishes, stops, or the tab reloads/closes.
- **offscreen:** writes media files independently of the side panel and Flow tab.
- **Flow host access:** runs the content script on supported Flow pages.
- **Optional media host access:** downloads generated files from `flow-content.google`, Google user-content/video hosts, and Google Cloud Storage.

The extension does not store account credentials or require a separate backend. Prompts are submitted to Google Flow as part of generation, and media downloads use the browser's authenticated session. Your Google account and Flow credits remain under your control. This project is not affiliated with or endorsed by Google.

## Project files

- `manifest.json`: Chrome extension registration and permissions.
- `panel.html`, `panel.css`, `panel.js`: side panel, queue previews, settings, and folder authorization.
- `content.js`: composer interaction, generation detection, and sequential queue processing.
- `background.js`: tab routing, debugger clicks, and download message validation.
- `offscreen.html`, `offscreen.js`: active background file writer, three-attempt retries, and IndexedDB save receipts/reservations to recover downloads without regenerating images.

## Troubleshooting

Version 1.5.11 keeps Flow's document active with Chrome's focus emulation while a queue runs, without activating its tab. It also detects a new downloadable Google asset before its lazy thumbnail finishes decoding. The existing checks still require a unique new result and no generation progress indicator before saving. Focus emulation is disabled when the queue finishes or stops; detaching also releases it. Reload the extension and Flow once after updating; future runs can continue while watching YouTube or using another tab.

- **Queue cannot connect:** reload both the extension and the Flow tab, then reopen the panel.
- **Write permission error:** open the panel and click Autorizar carpeta. Choose a new folder only if the original moved or was deleted.
- **Media permission error:** disable and re-enable automatic saving, then accept the media access request.
- **Queue stops with an uncertain result:** inspect Flow, use x1, let existing generations finish, and avoid manual generation during processing.
- **Unexpected duplicates:** stop processing and inspect the saved files and Flow results before retrying. Do not restart a completed prompt to recover only a failed download.
- **Generated artwork has unwanted borders:** specify edge-to-edge artwork with no white or cream frame in the prompt. The extension saves the generated file unchanged.

## License

MIT License. See [LICENSE](LICENSE).
