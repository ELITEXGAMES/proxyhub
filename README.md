# 🚀 Antigravity Proxy CLI

High-speed OpenAI & Anthropic compatible API proxy with multi-account load balancing, intelligent auto-fallback combos, Gemini Web session cookie integration, and NVIDIA NIM models.

---

## ⚡ Turnkey Install (Anyone in the World)

### Windows (PowerShell)
Run this single command in PowerShell:
```powershell
irm https://raw.githubusercontent.com/ELITEXGAMES/proxyhub/main/install.ps1 | iex
```
*(Or if you downloaded the repository, run `powershell -ExecutionPolicy Bypass -File install.ps1`)*

### macOS & Linux (Terminal)
Run this single command in Terminal:
```bash
curl -fsSL https://raw.githubusercontent.com/ELITEXGAMES/proxyhub/main/install.sh | bash
```

### Or via NPM (Directly from GitHub)
Run:
```bash
npm install -g ELITEXGAMES/proxyhub
```
*(Note: Do not run `npm install -g antigravity-proxy` as that installs an unrelated legacy package on npmjs. Use `ELITEXGAMES/proxyhub` directly).*

---

## 💻 CLI Commands

You can use either `anti gravity proxy`, `antigravity-proxy`, or `ag-proxy`:

| Command | Description |
|---|---|
| `anti gravity proxy start` | Start server in foreground |
| `anti gravity proxy start -d` | Start server in background (daemon mode) |
| `anti gravity proxy start -d -o` | Start in background and open dashboard in browser |
| `anti gravity proxy status` | View running state, PID, port, and connected accounts |
| `anti gravity proxy stop` | Stop background proxy daemon |
| `anti gravity proxy restart` | Restart proxy daemon cleanly |
| `anti gravity proxy update` | **Pull latest git updates & auto-restart with zero data loss** |
| `anti gravity proxy test` | **Run full 10-point end-to-end integration test suite** |
| `anti gravity proxy models [filter]` | List all 140+ available models (Antigravity, NVIDIA NIM, Claude, OpenAI) |
| `anti gravity proxy combos` | List all configured fallback combos and routing chains |
| `anti gravity proxy nvidia add <key>` | Add NVIDIA NIM key, verify live, and load all models |
| `anti gravity proxy nvidia list` | List saved NVIDIA NIM keys and cached model count |
| `anti gravity proxy nvidia test [id]` | Test NVIDIA key against NVIDIA's live API |
| `anti gravity proxy nvidia rm <id>` | Remove an NVIDIA NIM key |
| `anti gravity proxy cookie add <psid>` | Add Gemini Web dual session cookies |
| `anti gravity proxy cookie list` | List saved Gemini Web cookies |
| `anti gravity proxy cookie test [id]` | Test Gemini session cookie with Google |
| `anti gravity proxy cookie rm <id>` | Remove a Gemini cookie |
| `anti gravity proxy accounts` | List connected Google Antigravity, Gemini Web, & NVIDIA accounts |
| `anti gravity proxy dashboard` | Open web dashboard in default browser |
| `anti gravity proxy key list` | List proxy API keys |
| `anti gravity proxy key add <name>` | Create a new proxy API key |
| `anti gravity proxy key rm <id>` | Delete a proxy API key |
| `anti gravity proxy logs` | View the last 50 lines of server logs |
| `anti gravity proxy logs -f` | Tail server logs live |

---

## 🍪 Gemini Web Cookies & Models

Connect your Gemini Web session cookies (`__Secure-1PSID`) or tokens to unlock official Gemini Web models:

| Model ID | Description |
|---|---|
| `gemini-web-flash` | Gemini 2.5 Flash via Web Session (Ultra Fast) |
| `gemini-web-pro` | Gemini 2.5 Pro via Web Session (Deep Reasoning) |
| `gemini-web-thinking` | Gemini 2.5 with Extended Thinking Budget |
| `gemini-web-image` | Gemini Imagen 3 High-Quality Image Generation |
| `gemini-web-video` | Gemini Veo 2 High-Definition Video Generation |
| `gemini-web-search` | Gemini Grounded with Real-Time Google Search |

### 🧪 Testing Cookies
- **In Dashboard:** Click **"🪙 Add Gemini Cookie"** or open the **Accounts** tab → click **"🧪 Test Cookie"**. The proxy immediately verifies the session against Google Gemini.
- **In Combos:** Add any Gemini Web model or select `[Gemini Web] Cookie` as the step provider. If a quota spike occurs, it automatically falls back to your other accounts or NVIDIA NIM models!

---

## 🔄 Automatic Updates (`anti gravity proxy update`)

Whenever changes are pushed to your Git repository, anyone running the proxy anywhere in the world can run:

```bash
anti gravity proxy update
```

This single command automatically:
1. Pulls the latest commits from your Git repository (`git pull origin main`).
2. Installs any new dependencies (`npm install --omit=dev`).
3. Runs syntax validation on all files (`node --check`).
4. **Preserves 100% of user data:** Accounts, tokens, cookies, NVIDIA keys, and combos are stored safely in `~/.antigravity-proxy/store.json` outside the repo so they are never touched or overwritten.
5. Seamlessly restarts the proxy background daemon if it was running.

---

## 🌐 Complete Endpoints Matrix

- **Web Dashboard:** `http://localhost:4000/`
- **OpenAI Chat Completions:** `http://localhost:4000/v1/chat/completions` (Full streaming, tool calling, reasoning delta)
- **OpenAI Legacy Completions:** `http://localhost:4000/v1/completions`
- **OpenAI Embeddings:** `http://localhost:4000/v1/embeddings`
- **OpenAI Images Generation:** `http://localhost:4000/v1/images/generations`
- **OpenAI Video Generation:** `http://localhost:4000/v1/videos/generations`
- **Anthropic Messages API:** `http://localhost:4000/v1/messages` & `/messages` (Claude Code, Claude Desktop, Cursor, Cline compatible with tools & thinking)
- **Models List:** `http://localhost:4000/v1/models`
- **Health Check:** `http://localhost:4000/v1/health`
