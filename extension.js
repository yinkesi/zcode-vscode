'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const HISTORY_KEY = 'zcodeChat.history';
const SESSION_KEY = 'zcodeChat.sessionId';
const MAX_HISTORY = 200;

// ---------------------------------------------------------------------------
// zcode.cjs 定位
// ---------------------------------------------------------------------------

function candidateCliPaths() {
  const candidates = [];
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
  const programFiles86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  for (const root of [localAppData, programFiles, programFiles86, 'D:\\code']) {
    candidates.push(path.join(root, 'ZCode', 'resources', 'glm', 'zcode.cjs'));
  }
  candidates.push(path.join(os.homedir(), '.zcode', 'cli', 'zcode.cjs'));
  return candidates;
}

function firstExisting(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function resolveCli() {
  const configured = vscode.workspace.getConfiguration('zcodeChat').get('cliPath', '');
  if (configured) {
    if (!firstExisting(configured)) {
      throw new Error(`zcodeChat.cliPath 指向的文件不存在: ${configured}`);
    }
    return { path: configured, kind: configured.toLowerCase().endsWith('.cjs') ? 'cjs' : 'bin' };
  }
  for (const p of candidateCliPaths()) {
    if (firstExisting(p)) {
      return { path: p, kind: 'cjs' };
    }
  }
  return null;
}

function resolveCliAsync() {
  const local = resolveCli();
  if (local) return Promise.resolve(local);
  // PATH 上可能有 zcode 可执行文件（直接 spawn，不加 node 前缀）
  return new Promise((resolve, reject) => {
    execFile('where.exe', ['zcode'], (err, stdout) => {
      const first = err || !stdout ? null : stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (first) {
        resolve({ path: first, kind: first.toLowerCase().endsWith('.cjs') ? 'cjs' : 'bin' });
      } else {
        reject(new Error(
          '未找到 ZCode CLI (zcode.cjs)。请安装 ZCode 桌面版，或在设置 zcodeChat.cliPath 中填写 zcode.cjs 的完整路径。'
        ));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// 凭据：读取/解密 ZCode 桌面端共享凭据 (~/.zcode/v2/config.json)
// ---------------------------------------------------------------------------

function decryptCredential(value) {
  if (typeof value !== 'string' || !value.startsWith('enc:v1:')) {
    return value;
  }
  const secret =
    (process.env.ZCODE_CREDENTIAL_SECRET || '').trim() ||
    `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${os.userInfo().username}`;
  const key = crypto.createHash('sha256').update(secret).digest();
  const [ivB64, tagB64, dataB64] = value.slice('enc:v1:'.length).split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]).toString('utf-8');
}

function resolveCredentials() {
  const cfg = vscode.workspace.getConfiguration('zcodeChat');
  const apiKeySetting = cfg.get('apiKey', '').trim();
  const baseURLSetting = cfg.get('baseURL', '').trim();
  if (apiKeySetting && baseURLSetting) {
    return { apiKey: apiKeySetting, baseURL: baseURLSetting };
  }

  const providerId = cfg.get('providerId', 'builtin:bigmodel-coding-plan');
  const configFile = path.join(os.homedir(), '.zcode', 'v2', 'config.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
  } catch (err) {
    throw new Error(
      `无法读取 ZCode 桌面端配置 ${configFile}（${err.message}）。请先在 ZCode 桌面版中登录，或在设置中手动填写 zcodeChat.apiKey / zcodeChat.baseURL。`
    );
  }

  const provider = raw.provider && raw.provider[providerId];
  if (!provider) {
    throw new Error(
      `桌面端配置中没有 "${providerId}" 这个提供方。请先在 ZCode 桌面版中完成登录，或在设置中调整 zcodeChat.providerId。`
    );
  }

  const options = provider.options || {};
  const apiKey = apiKeySetting || decryptCredential(options.apiKey || '') || '';
  const baseURL = baseURLSetting || decryptCredential(options.baseURL || '') || '';
  if (!apiKey) {
    throw new Error('未找到 API Key。请确认 ZCode 桌面版已登录，或在 zcodeChat.apiKey 中手动填写。');
  }
  return { apiKey, baseURL };
}

// ---------------------------------------------------------------------------
// CLI 调用
// ---------------------------------------------------------------------------

function killTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    try { child.kill('SIGKILL'); } catch {}
  }
}

/**
 * 运行一次 zcode -p。
 * opts: { prompt, cwd, mode, sessionId?, attachments?: string[] }
 * 返回 { sessionId, response, elapsedMs, projection }
 */
function runPrompt(opts, onSpawn) {
  const started = Date.now();
  let child = null;
  const promise = (async () => {
    const cli = await resolveCliAsync();
    const creds = resolveCredentials();
    const cfg = vscode.workspace.getConfiguration('zcodeChat');
    const model = cfg.get('model', 'GLM-5.3-Flash');
    const providerShort = cfg.get('providerId', 'builtin:bigmodel-coding-plan').replace(/^builtin:/, '');
    const nodePath = cfg.get('nodePath', 'node') || 'node';

    const base = cli.kind === 'cjs' ? [cli.path] : [];
    const args = [
      ...base,
      '-p', opts.prompt,
      '--json',
      '--no-color',
      '--cwd', opts.cwd,
      '--mode', opts.mode,
    ];
    if (opts.sessionId) {
      args.push('--resume', opts.sessionId);
    }
    for (const file of opts.attachments || []) {
      args.push('--attach', file);
    }

    const env = {
      ...process.env,
      ZCODE_API_KEY: creds.apiKey,
      ZCODE_MODEL: `${providerShort}/${model}`,
    };
    if (creds.baseURL) {
      env.ZCODE_BASE_URL = creds.baseURL;
    }

    return await new Promise((resolve, reject) => {
      child = spawn(nodePath, args, { cwd: opts.cwd, env, windowsHide: true });
      if (onSpawn) onSpawn(child);
      let stdout = '';
      let stderr = '';
      const maxOut = 16 * 1024 * 1024;
      child.stdout.on('data', (d) => { if (stdout.length < maxOut) stdout += d.toString('utf-8'); });
      child.stderr.on('data', (d) => { if (stderr.length < maxOut) stderr += d.toString('utf-8'); });
      child.on('error', (err) => {
        reject(new Error(`无法启动 ZCode CLI（${err.message}）。请检查 zcodeChat.nodePath 与 zcodeChat.cliPath 设置。`));
      });
      child.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          const detail = (stderr || stdout || '').trim().split(/\r?\n/).slice(-6).join('\n');
          reject(new Error(`ZCode CLI 退出码 ${code}\n${detail}`));
        }
      });
    });
  })();

  return promise.then(({ stdout }) => {
    let json = null;
    try {
      json = JSON.parse(stdout.trim());
    } catch {
      const start = stdout.indexOf('{');
      const end = stdout.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try { json = JSON.parse(stdout.slice(start, end + 1)); } catch {}
      }
    }
    if (!json || typeof json.response !== 'string') {
      throw new Error(`ZCode CLI 返回了无法解析的输出：\n${stdout.slice(0, 800)}`);
    }
    return {
      sessionId: json.sessionId,
      response: json.response,
      elapsedMs: Date.now() - started,
      projection: json.projection,
    };
  });
}

// ---------------------------------------------------------------------------
// Webview Provider
// ---------------------------------------------------------------------------

class ZCodeChatViewProvider {
  static viewId = 'zcodeChat.view';

  constructor(context) {
    this.context = context;
    this.view = undefined;
    this.history = context.workspaceState.get(HISTORY_KEY, []);
    this.sessionId = context.workspaceState.get(SESSION_KEY, '');
    this.attachments = [];
    this.running = null;
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    view.onDidDispose(() => { this.view = undefined; });
    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    view.webview.html = this.buildHtml(view.webview);
  }

  buildHtml(webview) {
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css'));
    const nonce = Array.from(crypto.randomBytes(16), (b) => b.toString(16).padStart(2, '0')).join('');
    const model = vscode.workspace.getConfiguration('zcodeChat').get('model', 'GLM-5.3-Flash');
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js'));
    const logo = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><defs><linearGradient id="zg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7aa2ff"/><stop offset="1" stop-color="#4ade9b"/></linearGradient></defs><path fill="url(#zg)" d="M13.9 2.2c.5-.7 1.6-.2 1.4.6l-1.6 6h4.6c.7 0 1.1.8.6 1.3l-8.8 11.4c-.5.7-1.6.1-1.4-.7l1.7-6.6H5.9c-.7 0-1.1-.8-.6-1.3L13.9 2.2z"/></svg>`;
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; link-src ${webview.cspSource} https:;">
<link rel="stylesheet" href="${cssUri}">
</head>
<body>
  <header class="zc-header">
    <div class="zc-logo">${logo}</div>
    <div class="zc-titles">
      <span class="zc-title">ZCode Chat</span>
      <span class="zc-sub">${model} · 工作区会话</span>
    </div>
    <span id="statusdot" class="zc-dot idle" title="就绪"></span>
  </header>
  <div id="attachbar" class="attachbar hidden"></div>
  <div id="msgs" class="msgs">
    <div class="welcome">
      <div class="hero">${logo}</div>
      <div class="welcome-title">与 ZCode 对话</div>
      <div class="welcome-sub">能读写当前工作区的文件、运行命令、修改代码</div>
      <div class="prompt-chips">
        <button class="pchip">解释这个项目的结构</button>
        <button class="pchip">帮我检查代码里的问题</button>
        <button class="pchip">为当前项目写一个 README</button>
      </div>
    </div>
  </div>
  <div id="inputbar" class="inputbar">
    <textarea id="input" rows="1" placeholder="向 ZCode 提问…（Enter 发送，Shift+Enter 换行）"></textarea>
    <div class="inputrow">
      <button id="attach" class="ghost" title="把当前编辑器文件附加到下一条消息">📎 附加当前文件</button>
      <span class="spacer"></span>
      <button id="stop" class="danger hidden">■ 停止</button>
      <button id="send">发送 ↵</button>
    </div>
  </div>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }

  post(type, payload) {
    if (this.view) {
      this.view.webview.postMessage({ type, ...payload });
    }
  }

  persist() {
    this.context.workspaceState.update(HISTORY_KEY, this.history.slice(-MAX_HISTORY));
    this.context.workspaceState.update(SESSION_KEY, this.sessionId);
  }

  async onMessage(msg) {
    switch (msg.type) {
      case 'ready':
        this.post('history', { history: this.history.slice(-MAX_HISTORY), sessionId: this.sessionId });
        this.post('attachments', { attachments: this.attachments });
        break;
      case 'send':
        await this.send(msg.text);
        break;
      case 'stop':
        killTree(this.running);
        break;
      case 'newSession':
        this.newSession();
        break;
      case 'copy':
        vscode.env.clipboard.writeText(msg.text || '');
        break;
      case 'requestAttach':
        this.attachActiveFile();
        break;
      case 'openUrl': {
        try {
          const u = vscode.Uri.parse(String(msg.url || ''));
          if (u.scheme === 'https' || u.scheme === 'http') {
            vscode.env.openExternal(u);
          }
        } catch {}
        break;
      }
    }
  }

  newSession() {
    killTree(this.running);
    this.sessionId = '';
    this.history = [];
    this.attachments = [];
    this.persist();
    this.post('history', { history: [], sessionId: '' });
    this.post('attachments', { attachments: [] });
  }

  attachActiveFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      vscode.window.showInformationMessage('当前没有可附加的本地文件。');
      return;
    }
    const fsPath = editor.document.uri.fsPath;
    if (!this.attachments.includes(fsPath)) {
      this.attachments.push(fsPath);
      this.post('attachments', { attachments: this.attachments });
    }
  }

  sendSelection() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('当前没有打开的编辑器。');
      return;
    }
    const sel = editor.selection;
    const text = sel.isEmpty ? editor.document.getText() : editor.document.getText(sel);
    const lang = editor.document.languageId;
    const rel = vscode.workspace.asRelativePath(editor.document.uri);
    const snippet = `请看 \`${rel}\` 中的代码：\n\n\`\`\`${lang}\n${text}\n\`\`\`\n\n`;
    this.post('prefill', { text: snippet });
    this.open();
  }

  open() {
    // 先确保右侧辅助侧栏中的 ZCode 容器可见，再把焦点移入聊天视图
    vscode.commands.executeCommand('workbench.view.extension.zcode-chat').then(
      () => vscode.commands.executeCommand('zcodeChat.view.focus'),
      () => vscode.commands.executeCommand('zcodeChat.view.focus')
    );
  }

  workingDir() {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length) return folders[0].uri.fsPath;
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.scheme === 'file') return path.dirname(editor.document.uri.fsPath);
    return os.homedir();
  }

  async send(text) {
    text = (text || '').trim();
    if (!text || this.running) return;

    this.history.push({ role: 'user', content: text, attachments: [...this.attachments] });
    this.post('user', { content: text, attachments: [...this.attachments] });

    const attachments = this.attachments;
    this.attachments = [];
    this.post('attachments', { attachments: [] });

    const cwd = this.workingDir();
    const mode = vscode.workspace.getConfiguration('zcodeChat').get('mode', 'yolo');
    const sentSessionId = this.sessionId || undefined;

    this.post('busy', {});
    let result = null;
    try {
      this.running = null;
      const run = runPrompt({ prompt: text, cwd, mode, sessionId: sentSessionId, attachments },
        (child) => { this.running = child; });
      result = await run;
    } catch (err) {
      this.running = null;
      this.post('idle', {});
      // 会话失效时自动用新会话重试一次
      if (sentSessionId && /sess_|resume|session/i.test(String(err.message))) {
        try {
          result = await runPrompt({ prompt: text, cwd, mode, attachments });
        } catch (err2) {
          this.post('error', { message: String((err2 && err2.message) || err2) });
          this.persist();
          return;
        }
      } else {
        this.post('error', { message: String((err && err.message) || err) });
        this.persist();
        return;
      }
    }
    this.running = null;

    this.sessionId = result.sessionId || this.sessionId;
    this.history.push({ role: 'assistant', content: result.response, meta: { ms: result.elapsedMs } });
    this.persist();
    this.post('assistant', {
      content: result.response,
      meta: { ms: result.elapsedMs, projection: result.projection },
    });
    this.post('idle', {});
  }
}

// ---------------------------------------------------------------------------
// 激活
// ---------------------------------------------------------------------------

function activate(context) {
  const provider = new ZCodeChatViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ZCodeChatViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('zcodeChat.open', () => provider.open()),
    vscode.commands.registerCommand('zcodeChat.newSession', () => {
      provider.newSession();
      provider.open();
    }),
    vscode.commands.registerCommand('zcodeChat.attachActiveFile', () => {
      provider.attachActiveFile();
      provider.open();
    }),
    vscode.commands.registerCommand('zcodeChat.close', () => {
      // 隐藏右侧辅助侧栏（ZCode 面板所在位置）
      vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    }),
    vscode.commands.registerCommand('zcodeChat.sendSelection', () => provider.sendSelection())
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
