# OpenClaude Quick Start for macOS and Linux

This guide uses a standard shell such as Terminal, iTerm, bash, or zsh.

## 1. Install Node.js

Install Node.js 20 or newer from:

- `https://nodejs.org/`

Then check it:

```bash
node --version
npm --version
```

## 2. Install OpenClaude

```bash
npm install -g @gitlawb/openclaude
```

## 3. Start OpenClaude

```bash
openclaude
```

**No setup needed.** Zapi is the default provider. On first run, OpenClaude will prompt you for a free API key:

```
╔════════════════════════════════════════════╗
║        Zapi API Key Required               ║
║  Get your free key: https://z.os7.site     ║
╚════════════════════════════════════════════╝

  Enter Zapi API key (zp_...): _
```

Get your free key at **https://z.os7.site/dashboard**, paste it in, and you are ready to code.

To skip the prompt on future runs, add this to your `~/.bashrc` or `~/.zshrc`:

```bash
export ZAPI_API_KEY=zp_your-key-here
```

## 4. Pick a Different Provider (Optional)

### Option A: OpenAI

Replace `sk-your-key-here` with your real key.

```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=sk-your-key-here
export OPENAI_MODEL=gpt-4o

openclaude
```

### Option B: DeepSeek

```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=sk-your-key-here
export OPENAI_BASE_URL=https://api.deepseek.com/v1
export OPENAI_MODEL=deepseek-v4-flash

openclaude
```

Use `deepseek-v4-pro` when you want the stronger model. `deepseek-chat` and `deepseek-reasoner` still work as DeepSeek's legacy API aliases.

### Option C: Ollama

Install Ollama first from:

- `https://ollama.com/download`

Then run:

```bash
ollama pull llama3.1:8b

export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_BASE_URL=http://localhost:11434/v1
export OPENAI_MODEL=llama3.1:8b

openclaude
```

No API key is needed for Ollama local models.

### Option D: LM Studio

Install LM Studio first from:

- `https://lmstudio.ai/`

Then in LM Studio:

1. Download a model (e.g., Llama 3.1 8B, Mistral 7B)
2. Go to the "Developer" tab
3. Select your model and enable the server via the toggle

Then run:

```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_BASE_URL=http://localhost:1234/v1
export OPENAI_MODEL=your-model-name
# export OPENAI_API_KEY=lmstudio  # optional: some users need a dummy key

openclaude
```

Replace `your-model-name` with the model name shown in LM Studio.

No API key is needed for LM Studio local models (but uncomment the `OPENAI_API_KEY` line if you hit auth errors).

## 5. If `openclaude` Is Not Found

Close the terminal, open a new one, and try again:

```bash
openclaude
```

## 6. If Your Provider Fails

Check the basics:

### For Zapi

- make sure the key starts with `zp_`
- make sure you copied it fully from https://z.os7.site/dashboard

### For OpenAI or DeepSeek

- make sure the key is real
- make sure you copied it fully

### For Ollama

- make sure Ollama is installed
- make sure Ollama is running
- make sure the model was pulled successfully

### For LM Studio

- make sure LM Studio is installed
- make sure LM Studio is running
- make sure the server is enabled (toggle on in the "Developer" tab)
- make sure a model is loaded in LM Studio
- make sure the model name matches what you set in `OPENAI_MODEL`

## 7. Updating OpenClaude

```bash
npm install -g @gitlawb/openclaude@latest
```

## 8. Uninstalling OpenClaude

```bash
npm uninstall -g @gitlawb/openclaude
```

## Need Advanced Setup?

Use:

- [Advanced Setup](advanced-setup.md)
  For Codex, Gemini, Mistral, LiteLLM, provider profiles, and runtime diagnostics.
