(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  // ------------------------- 极简 Markdown 渲染 -------------------------

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function inlineMd(s) {
    s = escapeHtml(s);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, '$1<em>$2</em>');
    s = s.replace(/`([^`\n]+)`/g, function (m, c) { return '<code class="ic">' + c + '</code>'; });
    s = s.replace(/https?:\/\/[^\s<>"')\]]+/g, function (u) {
      return '<a href="' + u + '">' + u + '</a>';
    });
    return s;
  }

  function renderMarkdown(src) {
    const fences = [];
    let text = String(src || '').replace(/\r\n/g, '\n');
    text = text.replace(/```([\w+.-]*)\n?([\s\S]*?)(?:```|$)/g, function (m, lang, code) {
      fences.push({ lang: lang, code: code });
      return '\u0000FENCE' + (fences.length - 1) + '\u0000';
    });
    text = text.replace(/`([^`\n]+)`/g, function (m, c) {
      return '\u0000IC' + btoa(unescape(encodeURIComponent(c))).replace(/=/g, '') + '\u0000';
    });

    var lines = text.split('\n');
    var html = '', list = null, para = [];
    function flushPara() {
      if (para.length) { html += '<p>' + para.join('<br>') + '</p>'; para = []; }
    }
    function closeList() {
      if (list) { html += list === 'ul' ? '</ul>' : '</ol>'; list = null; }
    }
    function inline(raw) {
      var s = inlineMd(raw);
      s = s.replace(/\u0000IC([A-Za-z0-9+/=]*)\u0000/g, function (m, b64) {
        try { return '<code class="ic">' + escapeHtml(decodeURIComponent(escape(atob(b64)))) + '</code>'; }
        catch (e) { return m; }
      });
      return s;
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/\s+$/, '');
      var fence = line.match(/^\u0000FENCE(\d+)\u0000$/);
      if (fence) {
        flushPara(); closeList();
        var f = fences[Number(fence[1])];
        var id = 'cb' + i + '_' + Math.random().toString(36).slice(2, 7);
        html += '<div class="codeblock"><div class="codebar"><span>' + escapeHtml(f.lang || '') +
          '</span><button class="copybtn" data-target="' + id + '">复制</button></div>' +
          '<pre id="' + id + '"><code>' + escapeHtml(f.code.replace(/\n$/, '')) + '</code></pre></div>';
        continue;
      }
      var h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { flushPara(); closeList(); html += '<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'; continue; }
      var ul = line.match(/^[-*+]\s+(.*)$/);
      if (ul) { flushPara(); if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; } html += '<li>' + inline(ul[1]) + '</li>'; continue; }
      var ol = line.match(/^\d+[.)]\s+(.*)$/);
      if (ol) { flushPara(); if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; } html += '<li>' + inline(ol[1]) + '</li>'; continue; }
      if (/^\s*$/.test(line)) { flushPara(); closeList(); continue; }
      para.push(inline(line));
    }
    flushPara(); closeList();
    return html;
  }

  // ------------------------- DOM -------------------------

  var msgs = document.getElementById('msgs');
  var input = document.getElementById('input');
  var sendBtn = document.getElementById('send');
  var stopBtn = document.getElementById('stop');
  var attachBtn = document.getElementById('attach');
  var attachbar = document.getElementById('attachbar');
  var statusDot = document.getElementById('statusdot');

  var busy = false;
  var busyTimer = null;
  var busyStart = 0;
  var attachments = [];

  function scrollBottom() {
    msgs.scrollTop = msgs.scrollHeight;
  }

  function hideWelcome() {
    var w = msgs.querySelector('.welcome');
    if (w) w.classList.add('hidden');
  }

  function pathLeaf(p) { return String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop(); }

  function addAttachmentsEl(container, files) {
    if (!files || !files.length) return;
    var wrap = document.createElement('div');
    wrap.className = 'chips';
    files.forEach(function (f) {
      var chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = '📎 ' + pathLeaf(f);
      chip.title = f;
      wrap.appendChild(chip);
    });
    container.appendChild(wrap);
  }

  function addUser(text, files) {
    hideWelcome();
    var el = document.createElement('div');
    el.className = 'msg user';
    var label = document.createElement('div');
    label.className = 'role';
    label.textContent = '你';
    var body = document.createElement('div');
    body.className = 'body';
    body.textContent = text;
    el.appendChild(label);
    addAttachmentsEl(el, files);
    el.appendChild(body);
    msgs.appendChild(el);
    scrollBottom();
  }

  function addAssistant(text, meta) {
    hideWelcome();
    var el = document.createElement('div');
    el.className = 'msg assistant';
    var label = document.createElement('div');
    label.className = 'role';
    label.textContent = 'ZCode';
    var body = document.createElement('div');
    body.className = 'body md';
    body.innerHTML = renderMarkdown(text);
    el.appendChild(label);
    el.appendChild(body);
    if (meta && meta.ms) {
      var foot = document.createElement('div');
      foot.className = 'foot';
      var secs = (meta.ms / 1000).toFixed(1);
      foot.textContent = secs + 's';
      if (meta.projection && typeof meta.projection.totalTokenCount === 'number') {
        foot.textContent += ' · ' + meta.projection.totalTokenCount.toLocaleString() + ' tok';
      }
      el.appendChild(foot);
    }
    msgs.appendChild(el);
    scrollBottom();
  }

  function addError(text) {
    hideWelcome();
    var el = document.createElement('div');
    el.className = 'msg error';
    el.textContent = '⚠ ' + text;
    msgs.appendChild(el);
    scrollBottom();
  }

  function addBusy() {
    hideWelcome();
    var el = document.createElement('div');
    el.className = 'msg assistant busy';
    el.id = 'busyMsg';
    var label = document.createElement('div');
    label.className = 'role';
    label.textContent = 'ZCode';
    var body = document.createElement('div');
    body.className = 'body';
    body.innerHTML = '<span class="dots"><i></i><i></i><i></i></span> <span class="elapsed">0s</span> <span class="hint">正在思考与操作工作区…</span>';
    el.appendChild(label);
    el.appendChild(body);
    msgs.appendChild(el);
    busyStart = Date.now();
    busyTimer = setInterval(function () {
      var t = el.querySelector('.elapsed');
      if (t) t.textContent = Math.floor((Date.now() - busyStart) / 1000) + 's';
    }, 1000);
    scrollBottom();
  }

  function removeBusy() {
    if (busyTimer) { clearInterval(busyTimer); busyTimer = null; }
    var el = document.getElementById('busyMsg');
    if (el) el.remove();
  }

  function setBusy(b) {
    busy = b;
    sendBtn.disabled = b;
    input.disabled = false;
    stopBtn.classList.toggle('hidden', !b);
    if (statusDot) {
      statusDot.className = 'zc-dot ' + (b ? 'busy' : 'idle');
      statusDot.title = b ? 'ZCode 正在工作' : '就绪';
    }
    if (b) addBusy(); else removeBusy();
  }

  function renderAttachbar() {
    if (!attachments.length) {
      attachbar.classList.add('hidden');
      attachbar.innerHTML = '';
      return;
    }
    attachbar.classList.remove('hidden');
    attachbar.innerHTML = '';
    attachments.forEach(function (f, idx) {
      var chip = document.createElement('span');
      chip.className = 'chip removable';
      chip.textContent = '📎 ' + pathLeaf(f) + ' ✕';
      chip.title = f;
      chip.addEventListener('click', function () {
        attachments.splice(idx, 1);
        renderAttachbar();
      });
      attachbar.appendChild(chip);
    });
  }

  function renderHistory(history, sessionId) {
    msgs.querySelectorAll('.msg').forEach(function (el) { el.remove(); });
    var welcome = msgs.querySelector('.welcome');
    if (!history.length) {
      if (!welcome) {
        welcome = document.createElement('div');
        welcome.className = 'welcome';
        welcome.innerHTML = '<div class="welcome-title">与 ZCode 对话</div>' +
          '<div class="welcome-sub">开始新的对话吧。</div>';
        msgs.appendChild(welcome);
      }
      welcome.classList.remove('hidden');
      return;
    }
    if (welcome) welcome.classList.add('hidden');
    history.forEach(function (m) {
      if (m.role === 'user') addUser(m.content, m.attachments);
      else addAssistant(m.content, m.meta);
    });
    scrollBottom();
  }

  // ------------------------- 事件 -------------------------

  sendBtn.addEventListener('click', function () { doSend(); });
  stopBtn.addEventListener('click', function () { vscode.postMessage({ type: 'stop' }); });
  attachBtn.addEventListener('click', function () {
    // 附加当前文件：由扩展侧取 activeTextEditor
    vscode.postMessage({ type: 'requestAttach' });
  });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      doSend();
    }
  });
  input.addEventListener('input', function () {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  });

  msgs.addEventListener('click', function (e) {
    var chip = e.target.closest('.pchip');
    if (chip) {
      input.value = chip.textContent.trim();
      input.dispatchEvent(new Event('input'));
      input.focus();
      return;
    }
    var btn = e.target.closest('.copybtn');
    if (btn) {
      var pre = document.getElementById(btn.getAttribute('data-target'));
      if (pre) vscode.postMessage({ type: 'copy', text: pre.textContent });
      btn.textContent = '已复制';
      setTimeout(function () { btn.textContent = '复制'; }, 1200);
      return;
    }
    var a = e.target.closest('a');
    if (a) {
      e.preventDefault();
      vscode.postMessage({ type: 'openUrl', url: a.getAttribute('href') });
    }
  });

  function doSend() {
    var text = input.value.trim();
    if (!text || busy) return;
    input.value = '';
    input.style.height = 'auto';
    vscode.postMessage({ type: 'send', text: text });
  }

  window.addEventListener('message', function (e) {
    var m = e.data || {};
    switch (m.type) {
      case 'history':
        renderHistory(m.history || [], m.sessionId);
        break;
      case 'attachments':
        attachments = m.attachments || [];
        renderAttachbar();
        break;
      case 'user':
        addUser(m.content, m.attachments);
        break;
      case 'assistant':
        addAssistant(m.content, m.meta);
        break;
      case 'busy':
        setBusy(true);
        break;
      case 'idle':
        setBusy(false);
        input.focus();
        break;
      case 'error':
        addError(m.message || '发生未知错误');
        break;
      case 'prefill':
        input.value = m.text || '';
        input.dispatchEvent(new Event('input'));
        input.focus();
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
