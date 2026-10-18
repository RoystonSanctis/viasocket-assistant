# Setting Up Ollama (Local LLM) on macOS

Run free, 100% private models on your computer with viaSocket Assistant using [Ollama](https://ollama.com).

---

## Quick Start (Single Chained Command)

If you prefer to install, configure, and start everything at once, run this single chained command in your macOS Terminal:

```bash
brew install ollama && launchctl setenv OLLAMA_ORIGINS "chrome-extension://*" && brew services start ollama && ollama run llama3.2
```

Once the terminal finishes downloading the weights and presents the `>>>` prompt, your local LLM is running and ready.

---

## Step-by-Step Instructions

### 1. Install Ollama using Homebrew
```bash
brew install ollama
```

### 2. Allow Chrome Extensions to Communicate with Ollama
By default, Ollama blocks cross-origin requests from browser extensions for security. Enable communication by setting `OLLAMA_ORIGINS`:

```bash
launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"
```

> **Note:** If you run Ollama as an interactive terminal command instead of a service, you can also launch it with:
> ```bash
> OLLAMA_ORIGINS="chrome-extension://*" ollama serve
> ```

### 3. Start the Ollama Background Service
```bash
brew services start ollama
```

### 4. Download and Start the Llama 3.2 Model
[Llama 3.2](https://ollama.com/library/llama3.2) supports tool-calling and fits well within memory on Apple Silicon Macs:

```bash
ollama run llama3.2
```

When you see the interactive prompt:
```
>>> Send a message (/? for help)
```
the model is loaded into memory and ready to serve requests at `http://localhost:11434`.

---

## Connecting in viaSocket Assistant

1. Open the extension's settings by right-clicking the extension icon in your Chrome toolbar and choosing **Options** (or go to `chrome://extensions` → **Details** → **Extension options**).
2. Under **AI Provider**, select **Ollama (on this computer)**.
3. Under **Model**, select `llama3.2` (or type in any other tool-capable model you downloaded, e.g. `qwen2.5:7b`).
4. Click the **Connect and test** button.
5. You should see a green checkmark confirming that viaSocket Assistant connected to your local Ollama server and verified tool-calling support.

---

## Troubleshooting

- **CORS error or "Could not reach Ollama"**:
  Ensure `OLLAMA_ORIGINS` is configured:
  ```bash
  launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"
  brew services restart ollama
  ```
- **Check if Ollama is listening**:
  ```bash
  curl http://localhost:11434/api/tags
  ```
  This should return a JSON object with your installed models.
