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
8. Click **Iniciar cola** (Start queue). Keep the Flow tab and side panel open while processing.

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

1. Waits for Flow to remain idle for five seconds before submitting a prompt.
2. Writes the prompt into the visible composer and clicks Generate through Chrome's debugger, with a DOM click fallback.
3. Watches new Flow result cards rather than treating changes in image display size as new results. Media identity excludes temporary URL query parameters.
4. Waits for a loaded image or playable video. Visible loading indicators and percentages, including 99%, prevent completion. The result must remain stable without a detected loading indicator for seven seconds.
5. Accepts a single unambiguous result, optionally saves it, then waits another five seconds before continuing. Multiple detected outputs stop the queue for review; use x1.

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

Saving runs in the side panel, using its selected directory handle. Keep that panel open. Chrome may require choosing the folder again after a browser restart or extension reload. A saving failure stops the queue while leaving the generated result in Flow. When its output link has been retained, **Guardar imagen** retries the download; an expired link may require downloading directly from Flow.

## Updating

Pull the latest changes, or replace your extracted copy with the latest download. Click **Reload** for this extension at `chrome://extensions`, then reload the Flow tab and reopen the panel. Re-select the destination folder if Chrome requests write access again.

## Permissions and privacy

- **storage:** saves queue progress, download preferences, and numbering locally.
- **sidePanel:** displays the queue controls.
- **tabs:** identifies the Flow tab associated with queue commands.
- **debugger:** sends browser-level clicks to Flow; the connection is released when the run finishes, stops, or the tab reloads/closes.
- **offscreen:** retained for the legacy file-saving helper; the current saving path uses the side panel.
- **Flow host access:** runs the content script on supported Flow pages.
- **Optional media host access:** downloads generated files from `flow-content.google`, Google user-content/video hosts, and Google Cloud Storage.

The extension does not store account credentials or require a separate backend. Prompts are submitted to Google Flow as part of generation, and media downloads use the browser's authenticated session. Your Google account and Flow credits remain under your control. This project is not affiliated with or endorsed by Google.

## Project files

- `manifest.json`: Chrome extension registration and permissions.
- `panel.html`, `panel.css`, `panel.js`: side panel, queue previews, settings, and local file writing.
- `content.js`: composer interaction, generation detection, and sequential queue processing.
- `background.js`: tab routing, debugger clicks, and download message validation.
- `offscreen.html`, `offscreen.js`: legacy offscreen saving helper, retained but not used by the current saving path.

## Troubleshooting

- **Queue cannot connect:** reload both the extension and the Flow tab, then reopen the panel.
- **Write permission error:** click Choose folder again and authorize the destination in the current panel session.
- **Media permission error:** disable and re-enable automatic saving, then accept the media access request.
- **Queue stops with an uncertain result:** inspect Flow, use x1, let existing generations finish, and avoid manual generation during processing.
- **Unexpected duplicates:** stop processing and inspect the saved files and Flow results before retrying. Do not restart a completed prompt to recover only a failed download.
- **Generated artwork has unwanted borders:** specify edge-to-edge artwork with no white or cream frame in the prompt. The extension saves the generated file unchanged.

## License

MIT License. See [LICENSE](LICENSE).
