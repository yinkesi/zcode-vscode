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

/**
 * 可用模型列表：优先取桌面端配置里该套餐注册的模型，失败时回退到默认清单。
 */
function listModels() {
  const fallback = ['GLM-5.3-Flash', 'GLM-5.3'];
  const providerId = vscode.workspace.getConfiguration('zcodeChat').get('providerId', 'builtin:bigmodel-coding-plan');
  try {
    const configFile = path.join(os.homedir(), '.zcode', 'v2', 'config.json');
    const raw = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    const models = raw.provider && raw.provider[providerId] && raw.provider[providerId].models;
    const ids = models ? Object.keys(models).filter((k) => k && typeof k === 'string') : [];
    return ids.length ? ids : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 当前编辑器上下文：工作区、正在查看的文件、打开的标签页。
 * 每次发送时注入给 Agent，让它知道用户在哪、正在看什么文件。
 */
function activeContext() {
  const folders = vscode.workspace.workspaceFolders;
  const folder = folders && folders.length ? folders[0] : null;
  const editor = vscode.window.activeTextEditor;
  let activeFile = null;
  if (editor && editor.document.uri.scheme === 'file') {
    const abs = editor.document.uri.fsPath;
    activeFile = {
      path: folder ? vscode.workspace.asRelativePath(editor.document.uri, false) : abs,
      name: path.basename(abs),
      lang: editor.document.languageId,
      line: editor.selection.active.line + 1,
      selected: !editor.selection.isEmpty,
    };
  }
  let openEditors = [];
  try {
    openEditors = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => t.input && typeof t.input === 'object' && t.input.uri && t.input.uri.scheme === 'file')
      .map((t) => path.basename(t.input.uri.fsPath))
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 12);
  } catch {}
  return {
    workspace: folder ? { name: folder.name, path: folder.uri.fsPath } : null,
    activeFile,
    openEditors,
  };
}

/**
 * 把编辑器上下文作为前缀块注入 prompt（仅发给 CLI；聊天界面仍显示用户原文）。
 */
function buildPrompt(text, ctx) {
  const lines = [];
  if (ctx.workspace) lines.push(`工作区: ${ctx.workspace.name} (${ctx.workspace.path})`);
  if (ctx.activeFile) {
    lines.push(
      `用户当前正在查看的文件: ${ctx.activeFile.path} [${ctx.activeFile.lang}] 光标在第 ${ctx.activeFile.line} 行${ctx.activeFile.selected ? '，有选中区域' : ''}`
    );
  }
  if (ctx.openEditors && ctx.openEditors.length) {
    lines.push(`打开的标签页: ${ctx.openEditors.join(', ')}`);
  }
  if (!lines.length) return text;
  return `[VSCode 编辑器上下文]\n${lines.join('\n')}\n---\n\n${text}`;
}

// ---------------------------------------------------------------------------
// 运行日志与 Node 回退
// ---------------------------------------------------------------------------

let logChannel = null;
function log() {
  if (!logChannel) logChannel = vscode.window.createOutputChannel('ZCode Chat');
  const ts = new Date().toLocaleTimeString();
  logChannel.appendLine(`[${ts}] ${Array.from(arguments).map(String).join(' ')}`);
  return logChannel;
}

// spawn node 失败（ENOENT）时依次尝试常见安装位置
function listRolloutFiles() {
  try {
    return fs.readdirSync(path.join(os.homedir(), '.zcode', 'cli', 'rollout'))
      .filter((f) => f.startsWith('model-io-sess_') && f.endsWith('.jsonl'));
  } catch {
    return [];
  }
}
function nodeCandidates(primary) {
  const list = [primary, 'node'];
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  list.push(path.join(pf, 'nodejs', 'node.exe'));
  list.push(path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'nodejs', 'node.exe'));
  return Array.from(new Set(list.filter(Boolean)));
}

function spawnWithNodeFallback(nodePath, args, opts, onSpawn) {
  const candidates = nodeCandidates(nodePath);
  let attempt = 0;
  return new Promise((resolve, reject) => {
    const trySpawn = () => {
      if (attempt >= candidates.length) {
        reject(new Error(`无法启动 node。请确认已安装 Node.js，或在设置 zcodeChat.nodePath 中填写 node 的完整路径。`));
        return;
      }
      const bin = candidates[attempt++];
      let settled = false;
      let child;
      try {
        child = spawn(bin, args, opts);
      } catch (err) {
        log('node 启动异常:', bin, err.message);
        trySpawn();
        return;
      }
      child.once('error', (err) => {
        if (settled) return;
        settled = true;
        log('node 启动失败:', bin, err.message);
        if (err.code === 'ENOENT' && attempt < candidates.length) {
          trySpawn();
        } else {
          reject(err);
        }
      });
      child.once('spawn', () => {
        if (settled) return;
        settled = true;
        log('node:', bin);
        if (onSpawn) onSpawn(child);
        resolve(child);
      });
    };
    trySpawn();
  });
}

/**
 * 运行环境自检：CLI、Node、凭据、模型清单、端到端连通性。
 */
async function runDoctor() {
  const ch = log();
  ch.show();
  const results = [];
  const cfg = vscode.workspace.getConfiguration('zcodeChat');

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'ZCode 运行环境自检中…' },
    async (progress) => {
      // 1. CLI
      progress.report({ message: '检查 ZCode CLI…' });
      try {
        const cli = await resolveCliAsync();
        results.push(['✓', 'ZCode CLI', cli.path]);
        log('自检 CLI:', cli.path, `(${cli.kind})`);
      } catch (err) {
        results.push(['✗', 'ZCode CLI', String(err.message)]);
      }

      // 2. Node
      progress.report({ message: '检查 Node.js…' });
      const nodeVersion = await new Promise((resolve) => {
        const child = spawn(nodeCandidates(cfg.get('nodePath', 'node'))[0], ['-v'], { windowsHide: true });
        let out = '';
        child.on('error', () => resolve(null));
        child.stdout.on('data', (d) => { out += d; });
        child.on('close', (code) => resolve(code === 0 ? out.trim() : null));
      });
      results.push(nodeVersion ? ['✓', 'Node.js', nodeVersion] : ['✗', 'Node.js', '未找到，请安装 Node.js 或配置 zcodeChat.nodePath']);
      log('自检 Node:', nodeVersion || '未找到');

      // 3. 凭据
      progress.report({ message: '检查登录凭据…' });
      try {
        const creds = resolveCredentials();
        results.push(['✓', '登录凭据', `已读取（${cfg.get('providerId')}，Key 长度 ${creds.apiKey.length}）`]);
        log('自检凭据: OK, baseURL =', creds.baseURL || '(默认)');
      } catch (err) {
        results.push(['✗', '登录凭据', String(err.message)]);
      }

      // 4. 模型清单
      progress.report({ message: '读取模型清单…' });
      const models = listModels();
      const current = cfg.get('model', 'GLM-5.3-Flash');
      results.push([
        models.includes(current) ? '✓' : '!',
        '模型',
        `${current}（可用: ${models.join(', ')}）`,
      ]);

      // 5. 端到端连通性（只读模式发一条极短消息）
      if (results.every((r) => r[0] === '✓' || r[0] === '!')) {
        progress.report({ message: '端到端连通性测试（发送一条测试消息）…' });
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
        const t0 = Date.now();
        try {
          const r = await runPrompt({ prompt: '连通性测试。只回复两个字：正常', cwd, mode: 'plan' });
          const ok = /正常/.test(r.response);
          results.push([ok ? '✓' : '!', '端到端测试', `${r.response.trim().slice(0, 40)}（${Math.round((Date.now() - t0) / 100) / 10}s，模型 ${cfg.get('model')}）`]);
        } catch (err) {
          results.push(['✗', '端到端测试', String(err.message).split('\n')[0]]);
        }
      } else {
        results.push(['-', '端到端测试', '前置检查未全部通过，已跳过']);
      }
    }
  );

  ch.appendLine('');
  ch.appendLine('===== 自检结果 =====');
  for (const [mark, name, detail] of results) {
    ch.appendLine(`${mark} ${name}: ${detail}`);
  }
  ch.appendLine('====================');

  const failed = results.some((r) => r[0] === '✗');
  const summary = results.map(([m, n, d]) => `${m} ${n}: ${d}`).join('\n');
  const btnView = '查看日志';
  const msg = failed ? `ZCode 自检发现问题：\n\n${summary}` : `ZCode 运行环境一切正常：\n\n${summary}`;
  const choice = await vscode.window.showInformationMessage(msg, { modal: true }, btnView);
  if (choice === btnView) ch.show();
  log('自检完成，failed =', failed);
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
 * 把工具调用转成人类可读的活动条目。
 */
function describeToolCall(name, input) {
  const inp = input || {};
  const shortPath = (p) => String(p || '').replace(/\\/g, '/').split('/').slice(-2).join('/');
  const shortCmd = (c) => {
    const s = String(c || '').replace(/\s+/g, ' ');
    return s.length > 60 ? s.slice(0, 60) + '…' : s;
  };
  switch (name) {
    case 'Read': return { icon: '📄', text: '读取 ' + shortPath(inp.file_path) };
    case 'Write': return { icon: '📝', text: '写入 ' + shortPath(inp.file_path) };
    case 'Edit': return { icon: '✏️', text: '编辑 ' + shortPath(inp.file_path) };
    case 'Bash': return { icon: '⚡', text: inp.description ? inp.description : '运行 ' + shortCmd(inp.command) };
    case 'Grep': return { icon: '🔍', text: '搜索 ' + (inp.pattern || '') };
    case 'Glob': return { icon: '🔍', text: '查找 ' + (inp.pattern || '') };
    case 'TodoWrite': return { icon: '📋', text: '更新任务清单' };
    case 'WebSearch': return { icon: '🌐', text: '联网搜索 ' + (inp.query || '') };
    case 'WebFetch': return { icon: '🌐', text: '读取网页' };
    default:
      if (name.startsWith('mcp__computer-use__')) return { icon: '🖥️', text: '桌面操作 ' + name.replace('mcp__computer-use__', '') };
      if (name.startsWith('mcp__')) return { icon: '🔌', text: name.replace('mcp__', '') };
      return { icon: '🔧', text: name };
  }
}

/**
 * 解析一行 model-io JSONL，提取活动条目（工具调用 / 文本）。
 */
function parseModelIoLine(line) {
  let j;
  try { j = JSON.parse(line); } catch { return null; }
  if (j.type !== 'model_io' || !j.response) return null;
  const acts = [];
  for (const c of j.response.toolCalls || []) {
    const d = describeToolCall(c.name, c.input);
    acts.push({ kind: 'tool', icon: d.icon, text: d.text });
  }
  const text = (j.response.text || '').trim();
  if (text) {
    acts.push({ kind: 'say', text: text.length > 120 ? text.slice(0, 120) + '…' : text });
  }
  return acts.length ? acts : null;
}

/**
 * 在 CLI 运行期间轮询 rollout 的 model-io JSONL，把新工具活动实时回调出去。
 * - 续接会话：直接锁定 model-io-sess_<sessionId>.jsonl，只读本轮增量
 * - 新会话：只认 spawn 之后**新建**的 model-io 文件，避免误读其他并发会话
 * 返回 stop() 函数。
 */
function startActivityPolling(baselineFiles, resumeSessionId, onActivity) {
  const rolloutDir = path.join(os.homedir(), '.zcode', 'cli', 'rollout');
  const baseline = new Set(baselineFiles);
  let offset = 0;
  let target = null;
  let pending = [];
  let flushTimer = null;

  const flush = () => {
    flushTimer = null;
    if (pending.length) {
      onActivity(pending);
      pending = [];
    }
  };
  const queue = (items) => {
    pending = pending.concat(items);
    if (!flushTimer) flushTimer = setTimeout(flush, 300);
  };

  const tick = () => {
    try {
      if (!target) {
        if (resumeSessionId) {
          const f = path.join(rolloutDir, 'model-io-' + resumeSessionId + '.jsonl');
          if (fs.existsSync(f)) {
            target = f;
            offset = fs.statSync(f).size; // 只看本轮新增，不回放历史
            log('活动轮询锁定(续接):', path.basename(target));
          }
        } else {
          const files = fs.readdirSync(rolloutDir)
            .filter((f) => f.startsWith('model-io-sess_') && f.endsWith('.jsonl') && !baseline.has(f))
            .map((f) => {
              const full = path.join(rolloutDir, f);
              return { full, mtime: fs.statSync(full).mtimeMs };
            })
            .sort((a, b) => b.mtime - a.mtime);
          if (files.length) {
            target = files[0].full;
            offset = 0;
            log('活动轮询锁定(新会话):', path.basename(target));
          }
        }
      }
      if (target) {
        const size = fs.statSync(target).size;
        if (size > offset) {
          const fd = fs.openSync(target, 'r');
          const buf = Buffer.alloc(size - offset);
          fs.readSync(fd, buf, 0, buf.length, offset);
          fs.closeSync(fd);
          offset = size;
          for (const line of buf.toString('utf-8').split('\n')) {
            if (line.trim().length < 10) continue;
            const acts = parseModelIoLine(line);
            if (acts) queue(acts);
          }
        }
      }
    } catch {}
  };

  const timer = setInterval(tick, 700);
  tick();
  return () => {
    clearInterval(timer);
    if (flushTimer) clearTimeout(flushTimer);
    if (pending.length) onActivity(pending);
    pending = [];
  };
}

/**
 * 运行一次 zcode -p。
 * opts: { prompt, cwd, mode, sessionId?, attachments?, onActivity? }
 * 返回 { sessionId, response, elapsedMs, projection }
 */
function runPrompt(opts, onSpawn) {
  const started = Date.now();
  let child = null;
  const baselineFiles = listRolloutFiles();
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
    log(`发送: model=${providerShort}/${model} mode=${opts.mode} cwd=${opts.cwd} ${opts.sessionId ? 'resume ' + opts.sessionId : '新会话'} attachments=${(opts.attachments || []).length}`);

    return await new Promise((resolve, reject) => {
      spawnWithNodeFallback(nodePath, args, { cwd: opts.cwd, env, windowsHide: true }, (c) => {
        child = c;
        if (onSpawn) onSpawn(c);
      })
        .then((c) => {
          const stopPolling = typeof opts.onActivity === 'function'
            ? startActivityPolling(baselineFiles, opts.sessionId || null, opts.onActivity)
            : null;
          let stdout = '';
          let stderr = '';
          const maxOut = 16 * 1024 * 1024;
          c.stdout.on('data', (d) => { if (stdout.length < maxOut) stdout += d.toString('utf-8'); });
          c.stderr.on('data', (d) => { if (stderr.length < maxOut) stderr += d.toString('utf-8'); });
          c.on('close', (code) => {
            if (stopPolling) stopPolling();
            log(`CLI 退出码 ${code}，耗时 ${Math.round((Date.now() - started) / 100) / 10}s`);
            if (code === 0) {
              resolve({ stdout, stderr });
            } else {
              const detail = (stderr || stdout || '').trim().split(/\r?\n/).slice(-6).join('\n');
              log('CLI 失败详情:\n', detail);
              reject(new Error(`ZCode CLI 退出码 ${code}\n${detail}`));
            }
          });
        })
        .catch((err) => {
          reject(new Error(`无法启动 ZCode CLI（${err.message}）。请检查 zcodeChat.nodePath 与 zcodeChat.cliPath 设置。`));
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
    <span class="zc-titles">
      <span class="zc-title">ZCode Chat</span>
      <span class="zc-sub">工作区会话</span>
    </div>
    <button id="modelbtn" class="zc-model" title="点击切换模型">${model} <span class="chev">▾</span></button>
    <span id="statusdot" class="zc-dot idle" title="就绪"></span>
  </header>
  <div id="attachbar" class="attachbar hidden"></div>
  <div id="ctxbar" class="ctxbar hidden"></div>
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
      <button id="attach" class="ghost" title="把当前编辑器文件附加到下一条消息">📎 当前文件</button>
      <button id="addfile" class="ghost" title="搜索并引用工作区中的文件">＋ 引用文件</button>
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
        this.post('context', activeContext());
        this.post('model', { model: vscode.workspace.getConfiguration('zcodeChat').get('model', 'GLM-5.3-Flash') });
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
      case 'addFile':
        this.addFileReference();
        break;
      case 'selectModel':
        vscode.commands.executeCommand('zcodeChat.selectModel');
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

  /**
   * 弹出快速搜索面板，从当前工作区挑一个文件作为引用附件。
   */
  async addFileReference() {
    if (!vscode.workspace.workspaceFolders || !vscode.workspace.workspaceFolders.length) {
      vscode.window.showInformationMessage('请先打开一个工作区文件夹，再引用文件。');
      return;
    }
    const files = await vscode.workspace.findFiles(
      '**/*',
      '**/{node_modules,.git,dist,out,build,target,vendor,coverage,__pycache__,.venv,.next}/**',
      5000
    );
    if (!files.length) {
      vscode.window.showInformationMessage('工作区中没有找到可引用的文件。');
      return;
    }
    const items = files
      .map((uri) => ({
        label: path.basename(uri.fsPath),
        description: vscode.workspace.asRelativePath(uri, false),
        uri,
      }))
      .sort((a, b) => a.description.localeCompare(b.description));
    const pick = await vscode.window.showQuickPick(items, {
      title: 'ZCode Chat · 引用文件',
      placeHolder: '输入文件名搜索，回车确认',
      matchOnDescription: true,
    });
    if (!pick) return;
    if (!this.attachments.includes(pick.uri.fsPath)) {
      this.attachments.push(pick.uri.fsPath);
      this.post('attachments', { attachments: this.attachments });
    }
  }

  /**
   * 编辑器焦点 / 工作区变化时，把最新上下文推给 webview 显示。
   */
  pushContext() {
    this.post('context', activeContext());
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

    const ctx = activeContext();
    this.history.push({ role: 'user', content: text, attachments: [...this.attachments], ctx });
    this.post('user', { content: text, attachments: [...this.attachments], ctx });

    const attachments = this.attachments;
    this.attachments = [];
    this.post('attachments', { attachments: [] });

    const cwd = this.workingDir();
    const mode = vscode.workspace.getConfiguration('zcodeChat').get('mode', 'yolo');
    const sentSessionId = this.sessionId || undefined;
    const prompt = buildPrompt(text, ctx);

    this.post('busy', {});
    const activities = [];
    let result = null;
    try {
      this.running = null;
      const run = runPrompt({
        prompt, cwd, mode, sessionId: sentSessionId, attachments,
        onActivity: (items) => {
          for (const it of items) activities.push(it);
          this.post('activity', { items });
        },
      }, (child) => { this.running = child; });
      result = await run;
    } catch (err) {
      this.running = null;
      this.post('idle', {});
      // 会话失效时自动用新会话重试一次
      if (sentSessionId && /sess_|resume|session/i.test(String(err.message))) {
        try {
          result = await runPrompt({ prompt, cwd, mode, attachments });
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
    this.history.push({
      role: 'assistant',
      content: result.response,
      meta: { ms: result.elapsedMs, projection: result.projection },
      activities: activities.slice(0, 80),
    });
    this.persist();
    this.post('assistant', {
      content: result.response,
      meta: { ms: result.elapsedMs, projection: result.projection },
      activities: activities.slice(0, 80),
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
    vscode.commands.registerCommand('zcodeChat.addFileReference', () => {
      provider.addFileReference();
      provider.open();
    }),
    vscode.commands.registerCommand('zcodeChat.selectModel', async () => {
      const cfg = vscode.workspace.getConfiguration('zcodeChat');
      const current = cfg.get('model', 'GLM-5.3-Flash');
      const items = listModels().map((m) => ({
        label: m,
        description: m === current ? '✓ 当前使用' : '',
        picked: m === current,
      }));
      const pick = await vscode.window.showQuickPick(items, {
        title: 'ZCode Chat · 选择模型',
        placeHolder: '选择模型（对下一条消息生效）',
      });
      if (!pick || pick.label === current) return;
      await cfg.update('model', pick.label, vscode.ConfigurationTarget.Global);
      provider.post('model', { model: pick.label });
    }),
    vscode.commands.registerCommand('zcodeChat.doctor', () => runDoctor()),
    vscode.commands.registerCommand('zcodeChat.sendSelection', () => provider.sendSelection()),
    vscode.window.onDidChangeActiveTextEditor(() => provider.pushContext()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.pushContext())
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
