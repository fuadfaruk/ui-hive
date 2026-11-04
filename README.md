# UIHive

UIHive is a local-first UI design studio and a fork of Google's Flash-UI. Describe an interface, generate three distinct design directions, explore variations, and export HTML prototypes.

The React frontend runs in your browser. A local Express server handles model requests and encrypted credential storage, so your saved API key is not embedded in the frontend bundle. You choose the API endpoint and model rather than relying on a single built-in provider.

## Features

- Three HTML/CSS/JavaScript designs per prompt, with live previews as each design streams.
- A comparison grid, interactive focused previews, and navigation between prompt decks.
- Three conceptual variations of a completed design, with selected variations added to its deck.
- A source drawer with plain-text copying and standalone HTML downloads.
- Explicit prompt-idea refresh and a **Surprise Me** action.
- A **Stop** action that cancels generation while retaining partial source.
- Separate complete, incomplete, cancelled, and error states; incomplete exports are labeled.
- OpenAI-compatible Chat Completions and Anthropic-compatible Messages protocols, with custom endpoint URLs and model IDs.
- Windows CurrentUser DPAPI encryption for the saved connection and API key.

## Requirements

- **Windows**, for the built-in DPAPI credential store.
- **Node.js 24.x** and npm. The supported Node range is `>=24 <25`.
- A modern browser.
- An API key and access to a model endpoint supporting one of the two protocols above, including streamed text responses.

Local-first does not mean offline: prompts and, for variations, the selected design's HTML are sent to your configured endpoint. Provider charges can apply.

## Quick Start

Run these commands from the repository root:

```sh
npm ci
npm run dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000), or the URL printed in the terminal if you set a different `PORT`. Use `127.0.0.1`, not `localhost`: the backend checks the exact host and origin. The development command starts the local backend with Vite integrated into it; a separate Vite server is not required.

If PowerShell blocks `npm.ps1`, use `npm.cmd` in place of `npm`, or run the commands in Command Prompt. No required `.env` file or `GEMINI_API_KEY` variable is used; configure the connection in the app.

### Connect a Model

1. Open **Connection settings**.
2. Select the protocol and enter the **API URL** and **Model ID**.
3. Enter an API key accepted by that endpoint. The app requires a non-empty key even for local endpoints. Review the protocol-specific output-token settings if needed.
4. Optionally select **Test Connection** to make a small real model request. Testing does not save the connection.
5. Select **Save Connection** to persist the encrypted connection and enable generation.

Typical endpoint configurations:

| Protocol | API URL | Resolved request URL |
| --- | --- | --- |
| OpenAI-compatible | `https://api.openai.com/v1` | `https://api.openai.com/v1/chat/completions` |
| Anthropic-compatible | `https://api.anthropic.com/v1` | `https://api.anthropic.com/v1/messages` |
| OpenAI-compatible local server | `http://127.0.0.1:8080/v1` | `http://127.0.0.1:8080/v1/chat/completions` |

Use an actual model ID available through your endpoint. These URLs are examples, not a guarantee that every model offered by a provider is compatible.

The settings panel displays the resolved request URL. Include your provider's required API prefix: the app does not invent a missing `/v1`. Use HTTPS for remote endpoints; HTTP is allowed for loopback endpoints.

Custom API prefixes are preserved, and a full operation URL is also accepted without duplicating `/chat/completions` or `/messages`. URLs containing credentials, query strings, or fragments are rejected.

Leaving the key field blank retains a saved key only when the protocol and endpoint are unchanged. Changing either requires entering a key again. **Forget Key** deletes the saved connection, not just the password field.

**Compatibility:** These are Chat Completions and Messages adapters, not OpenAI Responses or native Gemini adapters. A successful connection test checks a short non-streaming request; it does not prove that the model accepts streaming, generation token limits, or the temperature parameters used for design generation.

Generation always sends output-token caps. OpenAI uses `max_tokens` unless `max_completion_tokens` is selected; turning the custom limit off does not omit the token field. Anthropic's saved limit defaults to 8,192 tokens. Saved limits can reduce, but not exceed, the app's per-phase budgets.

## Using the Studio

1. Enter a prompt and select **Generate**, or press `Enter`. Use `Shift+Enter` for a newline. An idea chip fills the prompt; **Surprise Me** starts generation from an idea.
2. Watch three designs populate the current deck. Generation plans the styles first, then streams the three HTML documents sequentially.
3. Focus a completed design to interact with its preview and switch between desktop and mobile preview modes. Use **Grid View** to return to the comparison grid.
4. Open **Source** to inspect, copy, or export its HTML. Partial results remain available after cancellation or an incomplete response.
5. Select **Variations** on a completed design, then apply a variation to add it to the current deck.
6. Navigate earlier and later decks to compare results from different prompts.

Example prompt:

```text
Design a calm focus timer with warm paper textures, oversized typography,
a working start/pause button, and a responsive layout for desktop and mobile.
```

Focused designs support left/right arrow navigation. `Escape` closes dialogs. **Refresh Ideas** explicitly requests new suggestions; opening the app or saving a connection does not trigger a model request.

A normal generation makes one planning request and three HTML streaming requests. **Test Connection**, **Refresh Ideas**, and **Variations** also make model requests. Only one model operation can run at a time across all tabs connected to the same server; stop it before changing the connection or starting another operation. Failed requests are not automatically retried.

## Build and Run

```sh
npm run build
npm start
```

The build type-checks the project, bundles the frontend into `dist/client/`, and compiles the backend and shared modules into `dist/server/` and `dist/shared/`. The start command serves the built frontend and local API together.

This is a local application, not a static-only site or a multi-user hosted service. Run the backend to use the studio, and keep it on its loopback address rather than exposing or forwarding it to a network.

The `PORT` environment variable selects the listening port, defaulting to `3000`; it must be an integer from `1` to `65535`. There is no `--port` command-line option. For example, in PowerShell:

```powershell
$env:PORT = '3001'
npm.cmd run dev
```

## Development and Tests

The stack is React 19, TypeScript, Vite 7, Express 5, Vitest, and Playwright.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the local server with TypeScript watch mode and Vite development middleware. |
| `npm run typecheck` | Check frontend, backend, shared code, and tests without emitting files. |
| `npm run build` | Type-check, build the frontend, and compile the backend. |
| `npm start` | Run the compiled application in production mode. |
| `npm test` | Run the Vitest unit and integration tests. |
| `npm run test:e2e` | Run Playwright browser tests for desktop and mobile viewports. |

Install Playwright's Chromium browser before the first browser-test run:

```sh
npx playwright install chromium
npm run test:e2e
```

Browser tests start their own application server at `http://127.0.0.1:3141` and a mock provider at `http://127.0.0.1:4319`. Keep both ports free; you do not need to start the development server first. They use disposable credentials and an in-memory store, not your saved connection or a real model API.

The Windows DPAPI test exercises real encryption across separate Node processes using a temporary connection file. It is skipped on non-Windows platforms.

## Project Structure

```text
src/                    React frontend, studio UI, and browser API client
server/
  index.ts              Local server startup and development/production serving
  app.ts                Operation-specific API routes and request validation
  connection.ts         Connection validation and Windows credential storage
  providers.ts          OpenAI/Anthropic request and streaming adapters
  generation.ts         Planning, HTML generation, ideas, and variations
  prompts.ts            Model prompts and design-generation rules
  runlog.ts             JSONL run diagnostics
shared/                 Shared types, stream parsing, and diagnostics
tests/                  Vitest unit and integration tests
e2e/                    Playwright scenarios and local mock provider
vite.config.ts          Frontend bundling configuration
tsconfig.server.json    Backend compilation configuration
```

Generation flows from the browser to the local API, then to the configured model endpoint. The backend normalizes provider responses into server-sent events for the frontend, which updates each artifact and renders its HTML in a sandboxed iframe. A failed candidate does not discard the other designs.

## Data and Security

### Saved Connection

The connection is stored at `%LOCALAPPDATA%\UI-Maker\connection.json`. Its settings and API key are encrypted with Windows DPAPI for the current Windows user. The directory name is `UI-Maker` even though the app is branded UIHive.

The frontend receives connection metadata and a saved-key indicator, not the stored key. The key is not persisted in browser local storage or session storage. DPAPI encryption is tied to the Windows user context, so copying the credential file is not a portable configuration backup. It does not protect against malicious software running as the same Windows user.

### Decks and Run Logs

Deck history is held in browser memory and disappears on reload. Export designs you want to keep; the saved connection survives reloads and server restarts.

Run logs are separate from deck history. File logging is **enabled by default in development and disabled by default in production**. When enabled, operations write plaintext JSONL diagnostics containing prompts, model settings, generated source, and failure details. Registered API keys are redacted, but logs are **not encrypted** and may contain sensitive prompt or design content.

- Development logs are written to `logs/`.
- Compiled production logs, when enabled, are written to `dist/logs/`.
- Reloading the page or selecting **Forget Key** does not delete run logs.
- Set `UI_HIVE_LOGS=0` in the server environment before startup to disable file logging.

Optional server diagnostic settings:

| Variable | Behavior |
| --- | --- |
| `UI_HIVE_LOGS=0` / `1` | Disable or enable persisted run logs, overriding the mode's default. |
| `UI_MAKER_DEBUG=0` | Disable server console diagnostics, which otherwise default on in both modes. |
| `UI_MAKER_DEBUG_SERVER=0` / `1` | Override server-specific console messages independently of `UI_MAKER_DEBUG`. |
| `UI_MAKER_TRACE=1` | Enable provider-inspector trace events in production; development tracing is always enabled. |

File logging, console diagnostics, and provider tracing are separate controls. Logs are not automatically rotated or deleted.

For example, in PowerShell:

```powershell
$env:UI_HIVE_LOGS = '0'
npm.cmd run dev
```

### Generated HTML

Previews execute generated scripts inside sandboxed, opaque-origin iframes with a restrictive content security policy. Remote assets and network requests are blocked in previews, so designs should use inline CSS, JavaScript, and assets.

Generated source remains untrusted executable HTML. Copied and exported documents include a warning, and incomplete exports are marked, but opening an exported file outside UIHive does not provide the studio's preview sandbox. Review the source before running it or integrating it into another project. Exports are HTML documents, not complete React application projects.

Model output is a prototype, not a correctness guarantee. Check its behavior, accessibility, responsiveness, and security before using it elsewhere.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| **Generate** is disabled | Save a valid connection, enter a non-empty prompt, and wait for or stop the current operation. |
| The local API rejects requests with HTTP 403 | Open the exact `http://127.0.0.1:<port>` URL printed by the server, not `localhost` or a forwarded address. |
| Requests reach the wrong route | Check the resolved request URL and your provider's required prefix, such as `/v1`. |
| Connection test works but generation fails | Verify that the model supports the selected protocol, SSE streaming, token-limit fields, and generation temperature parameters. |
| A design is marked incomplete | The provider may have reached an output/context limit or ended the stream early. Inspect the partial source, adjust supported token settings or simplify the prompt, and generate again. |
| The saved connection cannot be read | Run under the Windows user that saved it and check access to `%LOCALAPPDATA%`. If necessary, forget the connection and save it again. |
| PowerShell refuses to run npm | Use `npm.cmd` and `npx.cmd`, or use Command Prompt; changing the system execution policy is not required. |
| Browser tests cannot start their servers | Free ports `3141` and `4319` and ensure Playwright Chromium is installed. |
