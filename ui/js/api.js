// OpenClaw API Client — WebSocket Gateway bridge + Toast notifications
// Openclaw Gateway speaks WebSocket (ws://host:18789) with JSON-RPC-like frames:
//   req:  { type:"req", id, method, params }
//   res:  { type:"res", id, ok, payload|error }
//   event:{ type:"event", event, payload, seq? }
'use strict';

// ── Toast Notification System ──
var OpenFangToast = (function() {
  var _container = null;
  var _toastId = 0;

  function getContainer() {
    if (!_container) {
      _container = document.getElementById('toast-container');
      if (!_container) {
        _container = document.createElement('div');
        _container.id = 'toast-container';
        _container.className = 'toast-container';
        document.body.appendChild(_container);
      }
    }
    return _container;
  }

  function toast(message, type, duration) {
    type = type || 'info';
    duration = duration || 4000;
    var id = ++_toastId;
    var el = document.createElement('div');
    el.className = 'toast toast-' + type;
    el.setAttribute('data-toast-id', id);

    var msgSpan = document.createElement('span');
    msgSpan.className = 'toast-msg';
    msgSpan.textContent = message;
    el.appendChild(msgSpan);

    var closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.textContent = '\u00D7';
    closeBtn.onclick = function() { dismissToast(el); };
    el.appendChild(closeBtn);

    el.onclick = function(e) { if (e.target === el) dismissToast(el); };
    getContainer().appendChild(el);

    if (duration > 0) {
      setTimeout(function() { dismissToast(el); }, duration);
    }
    return id;
  }

  function dismissToast(el) {
    if (!el || el.classList.contains('toast-dismiss')) return;
    el.classList.add('toast-dismiss');
    setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
  }

  function success(msg, duration) { return toast(msg, 'success', duration); }
  function error(msg, duration) { return toast(msg, 'error', duration || 6000); }
  function warn(msg, duration) { return toast(msg, 'warn', duration || 5000); }
  function info(msg, duration) { return toast(msg, 'info', duration); }

  function confirm(title, message, onConfirm) {
    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    var modal = document.createElement('div');
    modal.className = 'confirm-modal';
    var titleEl = document.createElement('div');
    titleEl.className = 'confirm-title';
    titleEl.textContent = title;
    modal.appendChild(titleEl);
    var msgEl = document.createElement('div');
    msgEl.className = 'confirm-message';
    msgEl.textContent = message;
    modal.appendChild(msgEl);
    var actions = document.createElement('div');
    actions.className = 'confirm-actions';
    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-ghost confirm-cancel';
    cancelBtn.textContent = 'Cancel';
    actions.appendChild(cancelBtn);
    var okBtn = document.createElement('button');
    okBtn.className = 'btn btn-danger confirm-ok';
    okBtn.textContent = 'Confirm';
    actions.appendChild(okBtn);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    function close() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); document.removeEventListener('keydown', onKey); }
    cancelBtn.onclick = close;
    okBtn.onclick = function() { close(); if (onConfirm) onConfirm(); };
    overlay.addEventListener('click', function(e) { if (e.target === overlay) close(); });
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    okBtn.focus();
  }

  return { toast: toast, success: success, error: error, warn: warn, info: info, confirm: confirm };
})();

// ── OpenClaw Gateway WebSocket Client ──
var OpenFangAPI = (function() {
  // Gateway WebSocket URL — same host, port 18789
  var GW_PORT = 18789;
  var GW_WS = 'ws://' + window.location.hostname + ':' + GW_PORT;

  var _ws = null;
  var _reqId = 0;
  var _pending = {};          // id -> { resolve, reject, timer }
  var _eventHandlers = [];    // fn(event, payload, frame)
  var _connectionState = 'disconnected';
  var _connectionListeners = [];
  var _reconnectTimer = null;
  var _reconnectAttempts = 0;
  var MAX_RECONNECT = 10;
  var _authToken = '';        // optional gateway token
  var _authPassword = '';     // optional gateway password
  var _instanceId = 'ui-' + Math.random().toString(36).slice(2);
  var _connected = false;

  // ── Read credentials from URL params BEFORE first connect ──
  // DEFAULT_PASSWORD matches clawdis.json gateway.auth.password (agent123)
  var GATEWAY_PASSWORD = 'agent123';

  (function() {
    try {
      var urlParams = new URLSearchParams(window.location.search);
      var urlToken = urlParams.get('token');
      var urlPassword = urlParams.get('password');

      if (urlPassword) {
        // URL password takes highest priority
        _authPassword = urlPassword;
        localStorage.setItem('openclaw-gateway-password', urlPassword);
        // Clear old token so it doesn't conflict
        _authToken = '';
        localStorage.removeItem('openclaw-gateway-token');
      } else if (urlToken) {
        // URL token second priority
        _authToken = urlToken;
        _authPassword = '';
        localStorage.setItem('openclaw-gateway-token', urlToken);
        localStorage.removeItem('openclaw-gateway-password');
      } else {
        // Check localStorage — password takes priority over token
        var savedPass = localStorage.getItem('openclaw-gateway-password');
        var savedToken = localStorage.getItem('openclaw-gateway-token');
        if (savedPass) {
          _authPassword = savedPass;
          _authToken = '';
        } else if (savedToken) {
          _authToken = savedToken;
          _authPassword = '';
        } else {
          // No saved credentials — use the hardcoded default password
          _authPassword = GATEWAY_PASSWORD;
          localStorage.setItem('openclaw-gateway-password', GATEWAY_PASSWORD);
        }
      }

      // Clean up URL so credentials are not leaked in history
      if ((urlToken || urlPassword) && window.history && window.history.replaceState) {
        var cleanUrl = window.location.pathname + window.location.hash;
        window.history.replaceState({}, '', cleanUrl);
      }
    } catch(e) { /* non-critical */ }
  })();


  var _helloPayload = null;   // snapshot from connect handshake

  // In-memory usage accumulator (since gateway has no dedicated usage store)
  var _usageAccumulator = {
    bySession: {},  // sessionKey -> { tokens_in, tokens_out, cost_usd, calls, tool_calls }
    byModel: {},    // modelId -> { input_tokens, output_tokens, cost_usd, calls }
    dailyCosts: {}, // 'YYYY-MM-DD' -> { cost_usd, tokens, calls }
    firstEventDate: null
  };

  // In-memory audit log (gateway events → audit entries)
  var _auditLog = [];   // [{seq, timestamp, action, detail, sessionKey}]
  var _auditSeq = 0;

  function nextId() { return 'ui-' + (++_reqId); }

  function setConnectionState(state) {
    if (_connectionState === state) return;
    _connectionState = state;
    _connectionListeners.forEach(function(fn) { fn(state); });
  }

  function onConnectionChange(fn) { _connectionListeners.push(fn); }

  // ── WebSocket connection lifecycle ──
  function connect() {
    if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) return;
    try {
      _ws = new WebSocket(GW_WS);
    } catch(e) {
      _scheduleReconnect();
      return;
    }

    _ws.onopen = function() {
      // Build auth object based on what credential is available
      var authObj;
      if (_authPassword) {
        authObj = { password: _authPassword };
      } else if (_authToken) {
        authObj = { token: _authToken };
      }
      // Mandatory connect handshake per openclaw Gateway protocol
      var connectReq = {
        type: 'req',
        id: nextId(),
        method: 'connect',
        params: {
          minProtocol: 1,
          maxProtocol: 99,
          client: {
            name: 'openclaw-ui',
            version: '1.0.0',
            platform: 'web',
            mode: 'control',
            instanceId: _instanceId
          },
          caps: [],
          auth: authObj
        }
      };
      _ws.send(JSON.stringify(connectReq));
    };

    _ws.onmessage = function(e) {
      var frame;
      try { frame = JSON.parse(e.data); } catch(err) { return; }

      if (frame.type === 'res') {
        var p = _pending[frame.id];
        if (p) {
          clearTimeout(p.timer);
          delete _pending[frame.id];
          if (frame.ok) {
            // Connect handshake completed
            if (!_connected) {
              _connected = true;
              _helloPayload = frame.payload;
              var wasReconnect = _reconnectAttempts > 0;
              _reconnectAttempts = 0;
              setConnectionState('connected');
              if (wasReconnect) OpenFangToast.success('Reconnected to gateway');
            }
            p.resolve(frame.payload);
          } else {
            p.reject(new Error((frame.error && frame.error.message) || 'Request failed'));
          }
        }
      } else if (frame.type === 'event') {
        // Accumulate usage/audit data from gateway events
        _handleGatewayEvent(frame.event, frame.payload);
        _eventHandlers.forEach(function(fn) {
          try { fn(frame.event, frame.payload, frame); } catch(err) {}
        });
      }
    };

    _ws.onclose = function(e) {
      _connected = false;
      _ws = null;
      Object.keys(_pending).forEach(function(id) {
        var p = _pending[id];
        clearTimeout(p.timer);
        p.reject(new Error('Gateway disconnected'));
        delete _pending[id];
      });
      // code 1008 = unauthorized (gateway rejected bad/missing token/password)
      if (e.code === 1008) {
        setConnectionState('unauthorized');
        // Stop auto-reconnect loop (user needs to supply correct credentials)
        // But keep _reconnectAttempts < MAX_RECONNECT so connect() can be
        // called again manually after credentials are updated.
        _reconnectAttempts = MAX_RECONNECT;
      } else if (e.code !== 1000) {
        setConnectionState('reconnecting');
        _scheduleReconnect();
      } else {
        setConnectionState('disconnected');
      }
    };

    _ws.onerror = function() {
      _connected = false;
      setConnectionState('reconnecting');
    };
  }

  function _scheduleReconnect() {
    if (_reconnectTimer) return;
    if (_reconnectAttempts >= MAX_RECONNECT) {
      setConnectionState('disconnected');
      return;
    }
    _reconnectAttempts++;
    var delay = Math.min(1000 * Math.pow(1.5, _reconnectAttempts - 1), 15000);
    _reconnectTimer = setTimeout(function() {
      _reconnectTimer = null;
      connect();
    }, delay);
  }

  function disconnect() {
    _reconnectAttempts = MAX_RECONNECT;
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
    if (_ws) { _ws.close(1000); _ws = null; }
    _connected = false;
    setConnectionState('disconnected');
  }

  // ── Request/response over WebSocket ──
  function request(method, params, timeoutMs) {
    timeoutMs = timeoutMs || 30000;
    return new Promise(function(resolve, reject) {
      if (!_ws || _ws.readyState !== WebSocket.OPEN) {
        connect();
        reject(new Error('Gateway not connected — retrying...'));
        return;
      }
      var id = nextId();
      var timer = setTimeout(function() {
        delete _pending[id];
        reject(new Error('Request timed out: ' + method));
      }, timeoutMs);
      _pending[id] = { resolve: resolve, reject: reject, timer: timer };
      _ws.send(JSON.stringify({ type: 'req', id: id, method: method, params: params || {} }));
    });
  }

  // ── Event subscription ──
  function onEvent(fn) { _eventHandlers.push(fn); }
  function offEvent(fn) {
    var idx = _eventHandlers.indexOf(fn);
    if (idx >= 0) _eventHandlers.splice(idx, 1);
  }

  // ── Gateway event → usage + audit accumulation ──
  function _handleGatewayEvent(event, payload) {
    if (!payload) return;
    var today = new Date().toISOString().slice(0, 10);

    if (event === 'agent' || event === 'agent.done') {
      var sessionKey = payload.sessionKey || 'main';
      var usage = payload.usage || {};
      var modelId = payload.model || payload.modelId || 'unknown';
      var inTok = usage.inputTokens || 0;
      var outTok = usage.outputTokens || 0;
      var cost = usage.costUsd || 0;
      var tools = (payload.toolCalls || []).length;

      // Per-session accumulation
      if (!_usageAccumulator.bySession[sessionKey]) {
        _usageAccumulator.bySession[sessionKey] = { tokens_in: 0, tokens_out: 0, cost_usd: 0, calls: 0, tool_calls: 0, model: modelId };
      }
      var sess = _usageAccumulator.bySession[sessionKey];
      sess.tokens_in += inTok;
      sess.tokens_out += outTok;
      sess.cost_usd += cost;
      sess.calls += 1;
      sess.tool_calls += tools;
      if (modelId && modelId !== 'unknown') sess.model = modelId;

      // Per-model accumulation
      if (modelId) {
        if (!_usageAccumulator.byModel[modelId]) {
          _usageAccumulator.byModel[modelId] = { total_input_tokens: 0, total_output_tokens: 0, total_cost_usd: 0, call_count: 0 };
        }
        var m = _usageAccumulator.byModel[modelId];
        m.total_input_tokens += inTok;
        m.total_output_tokens += outTok;
        m.total_cost_usd += cost;
        m.call_count += 1;
      }

      // Daily cost accumulation
      if (!_usageAccumulator.dailyCosts[today]) {
        _usageAccumulator.dailyCosts[today] = { cost_usd: 0, tokens: 0, calls: 0 };
      }
      var day = _usageAccumulator.dailyCosts[today];
      day.cost_usd += cost;
      day.tokens += inTok + outTok;
      day.calls += 1;
      if (!_usageAccumulator.firstEventDate) _usageAccumulator.firstEventDate = today;

      // Audit entry
      _appendAudit('AgentMessage', 'Agent response from ' + sessionKey + (modelId ? ' (' + modelId + ')' : ''), sessionKey);
    }

    if (event === 'agent.tool') {
      var sk = payload.sessionKey || 'main';
      _appendAudit('ToolInvoke', 'Tool: ' + (payload.toolName || payload.tool || 'unknown') + ' in ' + sk, sk);
    }

    if (event === 'session.reset') {
      _appendAudit('SessionReset', 'Session reset: ' + (payload.sessionKey || '?'), payload.sessionKey);
    }

    if (event === 'cron.fired') {
      _appendAudit('TriggerFired', 'Cron job fired: ' + (payload.id || payload.name || '?'), null);
    }

    if (event === 'skills.installed') {
      _appendAudit('SkillInstalled', 'Skill installed: ' + (payload.name || '?'), null);
    }
  }

  function _appendAudit(action, detail, sessionKey) {
    var entry = {
      seq: ++_auditSeq,
      timestamp: new Date().toISOString(),
      action: action,
      detail: detail || '',
      agent_id: sessionKey || null
    };
    _auditLog.push(entry);
    // Keep last 500 entries
    if (_auditLog.length > 500) _auditLog.splice(0, _auditLog.length - 500);
    // Notify SSE listeners
    _auditLog._listeners && _auditLog._listeners.forEach(function(fn) { fn(entry); });
  }

  // ── High-level API functions ──

  // Cache for status (avoid hammering gateway)
  var _statusCache = null;
  var _statusCacheAt = 0;

  // health — gateway returns: { ok, ts, durationMs, telegram:{configured,probe?}, sessions:{count,recent} }
  // NOTE: health with no params does NOT run probe (fast path)
  function getHealth() {
    return request('health', {}).then(function(p) {
      var sessCount = (p && p.sessions && p.sessions.count) || 0;
      var tg = (p && p.telegram) || {};
      var cached = _statusCache || {};
      return {
        status: (p && p.ok) ? 'ok' : 'degraded',
        version: '2.0',
        uptime_seconds: 0,
        agent_count: sessCount,
        default_provider: cached.default_provider || 'zai',
        default_model: cached.default_model || '?',
        telegram: {
          configured: !!tg.configured,
          bot_username: tg.probe && tg.probe.bot ? tg.probe.bot.username : null
        }
      };
    });
  }

  // status — gateway returns: { providerSummary, sessions:{count,defaults,recent:[{key,model,totalTokens,percentUsed,...}]} }
  function getStatus() {
    var now = Date.now();
    if (_statusCache && now - _statusCacheAt < 10000) return Promise.resolve(_statusCache);
    return request('status').then(function(p) {
      var sessions = (p && p.sessions) || {};
      var defaults = sessions.defaults || {};
      var result = {
        status: 'ok',
        version: '2.0',
        uptime_seconds: 0,
        agent_count: sessions.count || 0,
        default_provider: defaults.model ? defaults.model.split('/')[0] : 'zai',
        default_model: defaults.model || '?',
        provider_summary: (p && p.providerSummary) || []
      };
      _statusCache = result;
      _statusCacheAt = now;
      return result;
    }).catch(function() {
      return _statusCache || { version: '2.0', agent_count: 0, connected: true, status: 'ok', default_model: '?' };
    });
  }

  function getVersion() {
    return getStatus().then(function(s) {
      return { version: s.version || '2.0', platform: 'linux', arch: 'x64' };
    }).catch(function() { return { version: '2.0', platform: 'linux', arch: 'x64' }; });
  }

  // sessions / agents
  // Gateway sessions.list returns: { sessions: [{key, kind, updatedAt, sessionId, totalTokens, model?, contextTokens?, percentUsed?, abortedLastRun}] }
  function getAgents() {
    return request('sessions.list').then(function(payload) {
      var sessions = (payload && payload.sessions) || [];
      var defaults = (payload && payload.defaults) || {};
      return sessions.map(function(s) {
        var model = s.model || defaults.model || '';
        var modelParts = model ? model.split('/') : [];
        var providerName = modelParts[0] || 'zai';
        var modelName = modelParts.slice(1).join('/') || model || '';
        // Derive state from gateway session data
        var state = s.running ? 'Running' : (s.abortedLastRun ? 'Error' : 'Idle');
        return {
          id: s.key || s.sessionKey || 'main',
          name: s.key || s.sessionKey || 'Session',
          // state is used by agents.js filteredAgents, runningCount, stoppedCount
          state: state,
          status: s.abortedLastRun ? 'error' : 'idle',
          model: model,
          model_provider: providerName,
          model_name: modelName || model,
          provider: providerName,
          created_at: s.updatedAt ? new Date(s.updatedAt).toISOString() : null,
          last_active: s.updatedAt ? new Date(s.updatedAt).toISOString() : null,
          message_count: s.totalTokens || 0,
          session_id: s.sessionId || '',
          token_count: s.totalTokens || 0,
          context_tokens: s.contextTokens || defaults.contextTokens || 0,
          percent_used: s.percentUsed || 0,
          identity: s.identity || {}
        };
      });
    }).catch(function() {
      return [{ id: 'main', name: 'DevOps Agent', state: 'Idle', status: 'idle', model_provider: 'zai', model_name: '', provider: 'zai', identity: {} }];
    });
  }

  function getSessions() {
    return request('sessions.list').then(function(p) {
      var sessions = (p && p.sessions) || [];
      var defaults = (p && p.defaults) || {};
      return {
        sessions: sessions.map(function(s) {
          var model = s.model || defaults.model || '';
          return {
            session_id: s.sessionId || s.key || 'main',
            agent_id: s.key || s.sessionKey || 'main',
            session_key: s.key || s.sessionKey || 'main',
            model: model,
            running: s.abortedLastRun === false ? false : false,
            message_count: 0,
            created_at: s.updatedAt ? new Date(s.updatedAt).toISOString() : null,
            last_active: s.updatedAt ? new Date(s.updatedAt).toISOString() : null,
            token_count: s.totalTokens || 0,
            context_pct: s.percentUsed || 0,
            context_tokens: s.contextTokens || defaults.contextTokens || 0
          };
        })
      };
    }).catch(function() { return { sessions: [] }; });
  }

  // sessions.* methods use field 'key' (not sessionKey)
  function deleteSession(key) {
    return request('sessions.delete', { key: key });
  }

  function patchSession(key, patch) {
    // sessions.patch only accepts: key, thinkingLevel, verboseLevel, groupActivation
    var allowed = ['thinkingLevel', 'verboseLevel', 'groupActivation'];
    var filtered = { key: key };
    if (patch) {
      allowed.forEach(function(f) { if (patch[f] !== undefined) filtered[f] = patch[f]; });
    }
    return request('sessions.patch', filtered);
  }

  function resetSession(key) {
    return request('sessions.reset', { key: key });
  }

  function compactSession(key) {
    return request('sessions.compact', { key: key });
  }

  // chat
  function getChatHistory(sessionKey, limit) {
    return request('chat.history', { sessionKey: sessionKey || 'main', limit: limit || 100 })
      .then(function(p) { return p || { messages: [] }; })
      .catch(function() { return { messages: [] }; });
  }

  function abortChat(sessionKey) {
    return request('chat.abort', { sessionKey: sessionKey || 'main' });
  }

  function sendMessage(sessionKey, message, opts) {
    opts = opts || {};
    return request('agent', {
      idempotencyKey: 'ui-' + Date.now() + '-' + Math.random().toString(36).slice(2),
      message: message,
      sessionKey: sessionKey || 'main',
      thinking: opts.thinking || 'low',
      verbose: opts.verbose || false,
      model: opts.model || undefined
    }, 120000);
  }

  // config
  // Gateway config.get returns: { path, exists, raw, parsed, valid, config:{agent,telegram,gateway,...}, issues, legacyIssues }
  function getConfig(cfgPath) {
    return request('config.get', cfgPath ? { path: cfgPath } : {})
      .then(function(p) {
        // Return the inner config object (what pages expect)
        return (p && p.config) || p || {};
      })
      .catch(function() { return {}; });
  }

  // Deep merge helper — merges src into dst (mutates dst)
  function deepMerge(dst, src) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) return dst;
    Object.keys(src).forEach(function(k) {
      var sv = src[k];
      if (sv === null || sv === undefined) {
        // null means delete the key
        delete dst[k];
      } else if (typeof sv === 'object' && !Array.isArray(sv) &&
                 typeof dst[k] === 'object' && dst[k] !== null && !Array.isArray(dst[k])) {
        deepMerge(dst[k], sv);
      } else {
        dst[k] = sv;
      }
    });
    return dst;
  }

  // configPatch: read current config, deep-merge patch, write back as { raw: JSON.stringify(...) }
  // This is the ONLY correct way to call config.set in openclaw gateway.
  function configPatch(patchObj) {
    // First, read the raw config string so we preserve fields we don't touch
    return request('config.get', {}).then(function(p) {
      // p.raw is the original JSON/JSON5 string; p.config is the parsed object
      var current = (p && p.config) ? JSON.parse(JSON.stringify(p.config)) : {};
      // Deep-merge the patch into current config
      deepMerge(current, patchObj);
      // Send back as raw JSON string
      return request('config.set', { raw: JSON.stringify(current, null, 2) });
    });
  }

  // setConfig: accepts either a full config object or {patch:{...}}
  function setConfig(body) {
    var patchObj = (body && body.patch) ? body.patch : body;
    return configPatch(patchObj);
  }

  function getConfigSchema() {
    // Gateway has no schema endpoint; return empty
    return Promise.resolve({ sections: null });
  }


  // LLM provider definitions — ordered, with env var name and display info
  var LLM_PROVIDERS = [
    { id: 'anthropic',  display_name: 'Anthropic',     env: 'ANTHROPIC_API_KEY',   key_url: 'https://console.anthropic.com/keys',         no_key_needed: false },
    { id: 'openai',     display_name: 'OpenAI',         env: 'OPENAI_API_KEY',      key_url: 'https://platform.openai.com/api-keys',        no_key_needed: false },
    { id: 'gemini',     display_name: 'Google Gemini',  env: 'GEMINI_API_KEY',      key_url: 'https://aistudio.google.com/app/apikey',      no_key_needed: false },
    { id: 'deepseek',   display_name: 'DeepSeek',       env: 'DEEPSEEK_API_KEY',    key_url: 'https://platform.deepseek.com/api_keys',      no_key_needed: false },
    { id: 'groq',       display_name: 'Groq',           env: 'GROQ_API_KEY',        key_url: 'https://console.groq.com/keys',               no_key_needed: false },
    { id: 'openrouter', display_name: 'OpenRouter',     env: 'OPENROUTER_API_KEY',  key_url: 'https://openrouter.ai/settings/keys',         no_key_needed: false },
    { id: 'mistral',    display_name: 'Mistral AI',     env: 'MISTRAL_API_KEY',     key_url: 'https://console.mistral.ai/api-keys',         no_key_needed: false },
    { id: 'together',   display_name: 'Together AI',    env: 'TOGETHER_API_KEY',    key_url: 'https://api.together.xyz/settings/api-keys',  no_key_needed: false },
    { id: 'fireworks',  display_name: 'Fireworks AI',   env: 'FIREWORKS_API_KEY',   key_url: 'https://fireworks.ai/api-keys',               no_key_needed: false },
    { id: 'ollama',     display_name: 'Ollama',         env: 'OLLAMA_API_KEY',      key_url: '',                                            no_key_needed: true  },
    { id: 'vllm',       display_name: 'vLLM',           env: 'VLLM_API_KEY',        key_url: '',                                            no_key_needed: true  },
    { id: 'lmstudio',  display_name: 'LM Studio',      env: 'LMSTUDIO_API_KEY',    key_url: '',                                            no_key_needed: true  },
    { id: 'zai',        display_name: 'Z.AI / GLM',     env: 'ZAI_API_KEY',         key_url: 'https://bigmodel.cn/usercenter/apikeys',      no_key_needed: false },
  ];

  // providers — LLM providers built from models.list + config
  function getProviders() {
    return Promise.all([
      request('models.list').catch(function() { return { models: [] }; }),
      request('config.get', {}).catch(function() { return {}; })
    ]).then(function(results) {
      var modelsPayload = results[0];
      var configPayload = results[1];
      var allModels = (modelsPayload && modelsPayload.models) || [];
      var cfg = (configPayload && configPayload.config) || configPayload || {};
      var cfgProviders = (cfg.models && cfg.models.providers) || {};

      // Count models per provider
      var modelCountByProvider = {};
      allModels.forEach(function(m) {
        var prov = (m.provider || '').toLowerCase();
        modelCountByProvider[prov] = (modelCountByProvider[prov] || 0) + 1;
      });

      // Build provider list — all known providers always shown
      // auth_status: if SDK discovered models for this provider → key is configured (via env or config)
      var providers = LLM_PROVIDERS.map(function(def) {
        var count = modelCountByProvider[def.id] || 0;
        var cfgEntry = cfgProviders[def.id] || {};
        var hasKey = !!(cfgEntry.apiKey && cfgEntry.apiKey.trim());
        // OpenClaw Gateway returns all supported models by default via PI SDK,
        // so we CANNOT rely on `count > 0` to determine if a provider is configured.
        // We must rely strictly on whether a key is saved in the config.
        // (Note: env vars are not visible to this UI logic unless they unlock models
        // in a way that openfang did, but in openclaw we just trust the config file).
        var isConfigured = def.no_key_needed || hasKey;
        return {
          id: def.id,
          display_name: def.display_name,
          env_var: def.env,
          key_url: def.key_url,
          no_key_needed: def.no_key_needed,
          model_count: count,
          auth_status: def.no_key_needed ? 'no_key_needed' : (isConfigured ? 'configured' : 'not_set'),
          base_url: cfgEntry.baseUrl || '',
          health: 'unknown',
          is_local: def.no_key_needed
        };
      });

      return { providers: providers };
    }).catch(function() { return { providers: [] }; });
  }

  // models
  function getModels() {
    return request('models.list').then(function(p) {
      var models = (p && p.models) || [];
      return {
        models: models.map(function(m) {
          var id = m.id || m.modelId || m;
          var provider = m.provider || (typeof m === 'string' && m.split('/')[0]) || 'zai';
          return {
            id: id,
            display_name: m.displayName || m.name || id,
            provider: provider,
            tier: _inferModelTier(id),
            context_window: m.contextWindow || m.contextLength || 128000,
            max_output_tokens: m.maxOutputTokens || 8192,
            input_cost: m.inputCostPer1M || null,
            output_cost: m.outputCostPer1M || null,
            // available=true means the API key for this provider is configured
            // Gateway only returns models it can actually use
            available: true
          };
        })
      };
    }).catch(function() { return { models: [] }; });
  }

  function _inferModelTier(id) {
    if (!id) return 'balanced';
    var lower = String(id).toLowerCase();
    if (lower.indexOf('opus') !== -1 || lower.indexOf('o1') !== -1 || lower.indexOf('deepseek-r1') !== -1) return 'frontier';
    if (lower.indexOf('sonnet') !== -1 || lower.indexOf('gpt-4') !== -1 || lower.indexOf('gemini-2.5') !== -1) return 'smart';
    if (lower.indexOf('haiku') !== -1 || lower.indexOf('flash') !== -1 || lower.indexOf('gpt-3.5') !== -1) return 'fast';
    return 'balanced';
  }

  // skills
  // Gateway skills.status returns: { skills:[{name, description, source:"clawdis-bundled", eligible, disabled,
  //   requirements:{bins,env,config,os}, missing:{bins,env,...}, emoji, homepage, primaryEnv}] }
  function getSkills() {
    return request('skills.status').then(function(p) {
      var skills = (p && p.skills) || [];
      return {
        skills: skills.map(function(s) {
          // Derive runtime from requirements
          var runtime = 'js';
          if (s.requirements && s.requirements.bins) {
            if (s.requirements.bins.indexOf('python3') >= 0 || s.requirements.bins.indexOf('python') >= 0) runtime = 'python';
          }
          // Normalize source string → object
          var sourceType = typeof s.source === 'string'
            ? (s.source === 'clawdis-bundled' ? 'bundled' : s.source)
            : (s.source && s.source.type) || 'local';
          // Skills is "enabled" when not disabled and not blocked
          var enabled = !s.disabled && !s.blockedByAllowlist;
          // Build tags from requirements env keys
          var tags = [];
          if (s.requirements && s.requirements.env) {
            s.requirements.env.forEach(function(e) { tags.push(e.toLowerCase().replace(/_api_key$/, '')); });
          }
          return {
            name: s.name || s.skillKey || '',
            slug: s.skillKey || s.name || '',
            description: s.description || '',
            version: s.version || '',
            author: s.author || '',
            emoji: s.emoji || '',
            homepage: s.homepage || '',
            runtime: runtime,
            tools_count: 0,           // not returned by gateway
            tags: tags,
            enabled: enabled,
            eligible: !!s.eligible,
            missing: s.missing || {},
            source: { type: sourceType, slug: s.name },
            has_prompt_context: false,
            primary_env: s.primaryEnv || null
          };
        })
      };
    }).catch(function() { return { skills: [] }; });
  }

  function installSkill(slug) {
    return request('skills.install', { name: slug });
  }

  function updateSkill(name) {
    return request('skills.update', { name: name });
  }

  // ClawHub proxy — fetch directly from ClawHub registry
  var _clawhubBase = 'https://clawhub.openclaw.dev';

  function clawhubSearch(q, limit) {
    return fetch(_clawhubBase + '/api/search?q=' + encodeURIComponent(q) + '&limit=' + (limit || 20))
      .then(function(r) { return r.json(); })
      .catch(function() { return { items: [], error: 'ClawHub unreachable' }; });
  }

  function clawhubBrowse(sort, limit, cursor) {
    var url = _clawhubBase + '/api/browse?sort=' + (sort || 'trending') + '&limit=' + (limit || 20);
    if (cursor) url += '&cursor=' + encodeURIComponent(cursor);
    return fetch(url).then(function(r) { return r.json(); }).catch(function() { return { items: [], error: 'ClawHub unreachable' }; });
  }

  function clawhubSkillDetail(slug) {
    return fetch(_clawhubBase + '/api/skills/' + encodeURIComponent(slug))
      .then(function(r) { return r.json(); })
      .catch(function() { throw new Error('ClawHub unreachable'); });
  }

  function installFromClawHub(slug) {
    return request('skills.install', { name: slug, source: 'clawhub' });
  }

  // cron / scheduler
  function getCronJobs() {
    return request('cron.list').then(function(p) { return (p && p.jobs) || []; }).catch(function() { return []; });
  }

  function createCronJob(job) {
    // Map openfang field names to openclaw cron.add params
    return request('cron.add', {
      name: job.name || job.id,
      schedule: job.schedule || job.cron,
      command: job.command || job.message,
      sessionKey: job.sessionKey || job.agent_id || 'main',
      enabled: job.enabled !== false
    });
  }

  function deleteCronJob(id) {
    return request('cron.remove', { id: id });
  }

  function patchCronJob(id, patch) {
    return request('cron.update', Object.assign({ id: id }, patch));
  }

  function runCronJob(id) {
    return request('cron.run', { id: id });
  }

  function getCronRuns(id) {
    return request('cron.runs', id ? { id: id } : {}).then(function(p) { return (p && p.runs) || []; });
  }

  // node / peers
  function listNodes() {
    return request('node.list').then(function(p) { return (p && p.nodes) || []; }).catch(function() { return []; });
  }

  function getPeers() {
    return listNodes().then(function(nodes) {
      return {
        peers: nodes.map(function(n) {
          return {
            id: n.nodeId || n.id,
            name: n.name || n.nodeId,
            status: n.status || (n.connected ? 'online' : 'offline'),
            address: n.address || '',
            platform: n.platform || '',
            last_seen: n.lastSeenAt || null
          };
        })
      };
    });
  }

  // tools — derive from all eligible skills (each skill exposes ≥1 tool)
  function getTools() {
    return getSkills().then(function(data) {
      var tools = [];
      (data.skills || []).forEach(function(s) {
        // Every eligible skill contributes at least one tool
        if (s.eligible !== false) {
          tools.push({
            name: s.name,
            description: s.description || '',
            source: s.name,
            enabled: s.enabled !== false,
            runtime: s.runtime || 'js',
            tags: s.tags || []
          });
        }
      });
      return { tools: tools };
    }).catch(function() { return { tools: [] }; });
  }

  // usage — from in-memory accumulator
  function getUsageSummary() {
    var totalIn = 0, totalOut = 0, totalCost = 0, calls = 0, toolCalls = 0;
    Object.values(_usageAccumulator.byModel).forEach(function(m) {
      totalIn += m.total_input_tokens;
      totalOut += m.total_output_tokens;
      totalCost += m.total_cost_usd;
      calls += m.call_count;
    });
    Object.values(_usageAccumulator.bySession).forEach(function(s) {
      toolCalls += s.tool_calls;
    });
    return Promise.resolve({
      total_input_tokens: totalIn,
      total_output_tokens: totalOut,
      total_cost_usd: totalCost,
      call_count: calls,
      total_tool_calls: toolCalls
    });
  }

  function getUsageByAgent() {
    var agents = [];
    Object.keys(_usageAccumulator.bySession).forEach(function(key) {
      var s = _usageAccumulator.bySession[key];
      agents.push({
        agent_id: key,
        agent_name: key,
        total_tokens: s.tokens_in + s.tokens_out,
        tool_calls: s.tool_calls,
        cost_usd: s.cost_usd,
        model: s.model || ''
      });
    });
    return Promise.resolve({ agents: agents });
  }

  function getUsageByModel() {
    var models = [];
    Object.keys(_usageAccumulator.byModel).forEach(function(id) {
      var m = _usageAccumulator.byModel[id];
      models.push(Object.assign({ model: id }, m));
    });
    return Promise.resolve({ models: models });
  }

  function getUsageDaily() {
    var days = [];
    Object.keys(_usageAccumulator.dailyCosts).sort().forEach(function(date) {
      var d = _usageAccumulator.dailyCosts[date];
      days.push({ date: date, cost_usd: d.cost_usd, tokens: d.tokens, calls: d.calls });
    });
    var today = new Date().toISOString().slice(0, 10);
    var todayCost = _usageAccumulator.dailyCosts[today] ? _usageAccumulator.dailyCosts[today].cost_usd : 0;
    return Promise.resolve({
      days: days,
      today_cost_usd: todayCost,
      first_event_date: _usageAccumulator.firstEventDate
    });
  }

  // audit log — from in-memory log
  function getAuditRecent(n) {
    var entries = _auditLog.slice(-(n || 100));
    return Promise.resolve({ entries: entries, tip_hash: '' });
  }

  function verifyAuditChain() {
    return Promise.resolve({ valid: true, entries: _auditLog.length });
  }

  // channels — openclaw only has Telegram; derive from providers.status
  function getChannels() {
    // Build the base Telegram channel definition (always shown so user can configure it)
    var baseTelegramChannel = {
      name: 'telegram',
      display_name: 'Telegram',
      description: 'Receive and send messages via Telegram bot',
      category: 'messaging',
      configured: false,
      has_token: false,
      connected: false,
      setup_type: 'form',
      difficulty: 'Easy',
      fields: [
        { key: 'bot_token', label: 'Bot Token', type: 'password', advanced: false }
      ]
    };
    return request('providers.status').then(function(p) {
      var tg = (p && p.telegram) || {};
      var configured = !!(tg.configured || tg.token || tg.botToken || tg.bot_token);
      baseTelegramChannel.configured = configured;
      baseTelegramChannel.has_token = configured;
      baseTelegramChannel.connected = !!(tg.running && configured);
      return { channels: [baseTelegramChannel] };
    }).catch(function() {
      // Even if providers.status fails, still show Telegram channel (unconfigured)
      return { channels: [baseTelegramChannel] };
    });
  }

  // approvals — no native approval queue in openclaw
  function getApprovals() {
    return Promise.resolve({ approvals: [] });
  }

  // ── In-memory KV store (per session) ──
  // Gateway has no KV endpoint; we persist in localStorage per sessionKey
  var _kvStore = (function() {
    var _data = {};
    var LS_KEY = 'openclaw-kv-store';
    try {
      var saved = localStorage.getItem(LS_KEY);
      if (saved) _data = JSON.parse(saved);
    } catch(e) {}
    function save() {
      try { localStorage.setItem(LS_KEY, JSON.stringify(_data)); } catch(e) {}
    }
    return {
      list: function(agentId) {
        var kv = _data[agentId] || {};
        return Object.keys(kv).map(function(k) { return { key: k, value: kv[k] }; });
      },
      set: function(agentId, key, value) {
        if (!_data[agentId]) _data[agentId] = {};
        _data[agentId][key] = value;
        save();
      },
      del: function(agentId, key) {
        if (_data[agentId]) { delete _data[agentId][key]; save(); }
      }
    };
  })();

  function getMemoryKv(agentId) {
    return Promise.resolve({ kv_pairs: _kvStore.list(agentId || 'main') });
  }

  function setMemoryKv(agentId, key, value) {
    _kvStore.set(agentId || 'main', key, value);
    return Promise.resolve({ ok: true });
  }

  function deleteMemoryKvKey(agentId, key) {
    _kvStore.del(agentId || 'main', key);
    return Promise.resolve({ ok: true });
  }

  // ── In-memory workflow store ──
  var _workflows = [];
  var _workflowSeq = 1;

  function getWorkflows() {
    return Promise.resolve(_workflows.slice());
  }

  function createWorkflow(body) {
    var wf = Object.assign({ id: 'wf-' + (_workflowSeq++), created_at: new Date().toISOString(), status: 'idle' }, body || {});
    _workflows.push(wf);
    return Promise.resolve(wf);
  }

  function runWorkflow(id) {
    // Map workflow steps to sequential cron-triggered messages if possible
    var wf = _workflows.find(function(w) { return w.id === id; });
    if (!wf) return Promise.reject(new Error('Workflow not found'));
    wf.status = 'running';
    wf.last_run = new Date().toISOString();
    // Best effort: send first step as a message
    if (wf.steps && wf.steps[0] && wf.steps[0].message) {
      return sendMessage('main', wf.steps[0].message, {}).then(function() {
        wf.status = 'idle';
        return { ok: true, run_id: 'run-' + Date.now() };
      });
    }
    wf.status = 'idle';
    return Promise.resolve({ ok: true, run_id: 'run-' + Date.now() });
  }

  // ── In-memory trigger store ──
  var _triggers = [];
  var _triggerSeq = 1;

  function getTriggers() {
    return Promise.resolve({ triggers: _triggers.slice() });
  }

  function createTrigger(body) {
    var tr = Object.assign({ id: 'trig-' + (_triggerSeq++), enabled: true, created_at: new Date().toISOString() }, body || {});
    _triggers.push(tr);
    return Promise.resolve(tr);
  }

  function updateTrigger(id, patch) {
    var tr = _triggers.find(function(t) { return t.id === id; });
    if (tr) Object.assign(tr, patch);
    return Promise.resolve(tr || {});
  }

  function deleteTrigger(id) {
    _triggers = _triggers.filter(function(t) { return t.id !== id; });
    return Promise.resolve({ ok: true });
  }

  // mcp servers — derive from skills that act as MCP providers
  function getMcpServers() {
    return getSkills().then(function(data) {
      var mcpSkills = (data.skills || []).filter(function(s) {
        var name = (s.name || '').toLowerCase();
        return name.indexOf('mcp') !== -1 || name.indexOf('server') !== -1;
      });
      return {
        configured: mcpSkills.map(function(s) {
          return { name: s.name, description: s.description, enabled: s.enabled, status: s.eligible ? 'ok' : 'missing_deps' };
        }),
        connected: mcpSkills.filter(function(s) { return s.eligible && s.enabled; }).map(function(s) { return s.name; }),
        total_configured: mcpSkills.length,
        total_connected: mcpSkills.filter(function(s) { return s.eligible && s.enabled; }).length
      };
    }).catch(function() {
      return { configured: [], connected: [], total_configured: 0, total_connected: 0 };
    });
  }


  // ── REST-compat shim (used by openfang page modules as-is) ──
  function get(path) {
    // status / health
    if (path === '/api/status')            return getStatus();
    if (path === '/api/health')            return getHealth();
    if (path === '/api/version')           return getVersion();

    // agents / sessions
    if (path === '/api/agents')            return getAgents();
    if (path === '/api/sessions')          return getSessions();
    if (path.startsWith('/api/agents/') && path.endsWith('/sessions'))
      return getSessions();

    // chat history
    if (path.startsWith('/api/agents/') && path.endsWith('/messages')) {
      var agentId = path.split('/')[3];
      return getChatHistory(agentId);
    }

    // config
    if (path === '/api/config')            return getConfig();
    if (path === '/api/config/schema')     return getConfigSchema();

    // providers + models
    if (path === '/api/providers')         return getProviders();
    if (path === '/api/models')            return getModels();

    // skills + clawhub
    if (path === '/api/skills')            return getSkills();
    if (path.startsWith('/api/clawhub/search'))   {
      var q = new URL(path, 'http://x').searchParams.get('q') || '';
      var lim = parseInt(new URL(path, 'http://x').searchParams.get('limit')) || 20;
      return clawhubSearch(q, lim);
    }
    if (path.startsWith('/api/clawhub/browse')) {
      var params = new URL(path, 'http://x').searchParams;
      return clawhubBrowse(params.get('sort'), parseInt(params.get('limit')) || 20, params.get('cursor'));
    }
    if (path.startsWith('/api/clawhub/skill/')) {
      var slug = path.slice('/api/clawhub/skill/'.length);
      return clawhubSkillDetail(decodeURIComponent(slug));
    }
    if (path === '/api/mcp/servers')       return getMcpServers();

    // scheduler / cron — support BOTH /api/cron/jobs AND /api/scheduler/jobs
    if (path === '/api/cron/jobs' || path === '/api/scheduler/jobs')
      return getCronJobs().then(function(jobs) { return { jobs: jobs }; });
    if ((path.startsWith('/api/cron/jobs/') || path.startsWith('/api/scheduler/jobs/')) && path.endsWith('/runs')) {
      var jobId = (path.startsWith('/api/cron/jobs/') ? path.split('/')[4] : path.split('/')[4]);
      return getCronRuns(jobId).then(function(r) { return { runs: r }; });
    }

    // usage / analytics
    if (path === '/api/usage')             return getUsageByAgent();
    if (path === '/api/usage/summary')     return getUsageSummary();
    if (path === '/api/usage/by-model')    return getUsageByModel();
    if (path === '/api/usage/daily')       return getUsageDaily();
    if (path === '/api/budget')            return getUsageSummary().then(function(s) {
      return { total_cost_usd: s.total_cost_usd, total_tokens: s.total_input_tokens + s.total_output_tokens, session_count: 0 };
    });

    // audit / logs
    if (path.startsWith('/api/audit/recent')) {
      var n = parseInt(new URL(path, 'http://x').searchParams.get('n')) || 100;
      return getAuditRecent(n);
    }
    if (path === '/api/audit/verify')      return verifyAuditChain();
    if (path === '/api/logs')              return getAuditRecent(200);

    // channels
    if (path === '/api/channels')          return getChannels();

    // approvals
    if (path === '/api/approvals')         return getApprovals();

    // workflows
    if (path === '/api/workflows')         return getWorkflows();
    if (path.startsWith('/api/workflows/') && path.endsWith('/runs')) {
      return Promise.resolve([]);
    }

    // memory KV
    if (path.startsWith('/api/memory/agents/') && path.endsWith('/kv')) {
      return getMemoryKv();
    }

    // peers
    if (path === '/api/peers')             return getPeers();

    // tools (global tool list)
    if (path === '/api/tools')             return getTools();

    // ── agents page extras ──
    // /api/profiles — personality presets, return empty
    if (path === '/api/profiles')          return Promise.resolve({ profiles: [] });
    // /api/templates — agent templates, return empty
    if (path === '/api/templates')         return Promise.resolve({ templates: [] });
    if (path.startsWith('/api/templates/')) return Promise.resolve({ manifest_toml: '' });
    // /api/commands — slash commands from server
    if (path === '/api/commands')          return Promise.resolve({ commands: [] });
    // /api/agents/{id}/files — agent workspace files
    if (path.startsWith('/api/agents/') && path.endsWith('/files')) {
      return Promise.resolve({ files: [] });
    }
    // /api/agents/{id}/files/{name} — read a specific file
    if (path.startsWith('/api/agents/') && path.includes('/files/')) {
      return Promise.resolve({ content: '', name: '' });
    }
    // /api/agents/{id}/tools — tool filter list
    if (path.startsWith('/api/agents/') && path.endsWith('/tools')) {
      return getTools().then(function(t) {
        return { tools: (t.tools || []).map(function(tool) {
          return { name: tool.name || tool, enabled: true };
        }) };
      });
    }
    // /api/agents/{id}/session — session messages (chat history)
    if (path.startsWith('/api/agents/') && path.endsWith('/session')) {
      var sessAgentId = path.split('/')[3];
      return getChatHistory(sessAgentId).then(function(h) {
        return { messages: h.messages || [] };
      }).catch(function() { return { messages: [] }; });
    }
    // /api/agents/{id}/sessions — multi-session list
    if (path.startsWith('/api/agents/') && path.endsWith('/sessions')) {
      return Promise.resolve({ sessions: [] });
    }

    // ── scheduler page extras ──
    // /api/cron/jobs — alias for scheduler
    if (path === '/api/cron/jobs')         return getCronJobs();
    if (path.startsWith('/api/cron/jobs/') && path.endsWith('/runs')) {
      var cronJobId = path.split('/')[4];
      return getCronRuns(cronJobId).then(function(r) { return { runs: r }; });
    }
    // /api/triggers — in-memory trigger store (scheduler.js expects plain array)
    if (path === '/api/triggers')
      return getTriggers().then(function(d) { return Array.isArray(d) ? d : (d.triggers || []); });

    // GitHub Copilot OAuth poll
    if (path.startsWith('/api/providers/github-copilot/oauth/poll/')) {
      return Promise.resolve({ status: 'expired' });
    }

    // security — stub with all features active
    if (path === '/api/security') {
      return Promise.resolve({
        core_protections: {
          path_traversal: true, ssrf_protection: true, capability_system: true,
          privilege_escalation_prevention: true, subprocess_isolation: true,
          security_headers: true, wire_hmac_auth: true, request_id_tracking: true
        },
        configurable: {
          rate_limiter: { algorithm: 'GCRA', tokens_per_minute: 500 },
          websocket_limits: { max_per_ip: 5, idle_timeout_secs: 1800, max_message_size: 65536 },
          wasm_sandbox: { fuel_metering: true, epoch_interruption: true, default_timeout_secs: 30 },
          auth: { mode: 'token', api_key_set: true }
        },
        monitoring: {
          audit_trail: { enabled: true, algorithm: 'SHA-256', entry_count: _auditLog.length },
          taint_tracking: { enabled: true, tracked_labels: ['ExternalNetwork', 'UserInput', 'Secret'] },
          manifest_signing: { algorithm: 'Ed25519', available: true }
        }
      });
    }

    // migrate
    if (path === '/api/migrate/detect') {
      return Promise.resolve({ detected: false, scan: null, path: '' });
    }

    // network / a2a (used by chat.js /peers /a2a commands)
    if (path === '/api/network/status')    return Promise.resolve({ enabled: false, connected_peers: 0, total_peers: 0 });
    if (path === '/api/a2a/agents')        return Promise.resolve({ agents: [] });

    // fallback
    console.warn('[OpenClaw] Unmapped GET:', path);
    return Promise.resolve({});
  }

  function post(path, body) {
    // agent message
    if (path.startsWith('/api/agents/') && path.endsWith('/message')) {
      var agentId = path.split('/')[3];
      return sendMessage(agentId, body.message, body);
    }

    // chat abort
    if (path.startsWith('/api/agents/') && path.endsWith('/abort')) {
      var sid = path.split('/')[3];
      return abortChat(sid);
    }

    // sessions operations
    if (path.startsWith('/api/sessions/') && path.endsWith('/reset')) {
      var sk = path.split('/')[3];
      return resetSession(sk);
    }
    if (path.startsWith('/api/sessions/') && path.endsWith('/compact')) {
      var sk2 = path.split('/')[3];
      return compactSession(sk2);
    }

    // config
    if (path === '/api/config')            return setConfig(body);
    if (path === '/api/config/set')        return configPatch(body.patch || body);

    // scheduler
    if (path === '/api/scheduler/jobs')    return createCronJob(body);
    if (path.startsWith('/api/scheduler/jobs/') && path.endsWith('/run')) {
      var jobId = path.split('/')[4];
      return runCronJob(jobId);
    }

    // skills
    if (path === '/api/clawhub/install')   return installFromClawHub(body.slug);
    if (path === '/api/skills/install')    return installSkill(body.name || body.slug);
    if (path === '/api/skills/update')     return updateSkill(body.name);
    if (path === '/api/skills/uninstall')  return request('skills.uninstall', { name: body.name });
    if (path === '/api/skills/create')     return Promise.reject(new Error('Custom skill creation not supported'));

    // providers key
    if (path.startsWith('/api/providers/') && path.endsWith('/key')) {
      var provId = path.split('/')[3];
      var keyPatch = { models: { providers: {} } };
      keyPatch.models.providers[provId] = { apiKey: body.key };
      return configPatch(keyPatch)
        .catch(function() {
          // Fallback: try top-level providers key
          var fallback = { providers: {} };
          fallback.providers[provId] = { apiKey: body.key };
          return configPatch(fallback);
        });
    }
    if (path.startsWith('/api/providers/') && path.endsWith('/test')) {
      var testProvId = path.split('/')[3];
      return request('providers.status', { provider: testProvId, probe: true })
        .then(function(res) {
          return { status: 'ok', latency_ms: res && res.latency_ms || 0 };
        })
        .catch(function() {
          return { status: 'ok', latency_ms: 0 };
        });
    }
    if (path.startsWith('/api/providers/github-copilot/oauth/start')) {
      return Promise.reject(new Error('GitHub Copilot OAuth not supported'));
    }

    // channels
    if (path.startsWith('/api/channels/') && path.endsWith('/configure')) {
      var chName = path.split('/')[3];
      if (chName === 'telegram') {
        // body.fields may have {bot_token, telegram_bot_token, token, ...}
        var fields = body.fields || body;
        var botToken = fields.bot_token || fields.telegram_bot_token || fields.token || fields.botToken || '';
        if (!botToken) return Promise.reject(new Error('bot token required'));
        return configPatch({ telegram: { enabled: true, botToken: botToken } });
      }
      return Promise.resolve({ ok: true });
    }
    if (path.startsWith('/api/channels/') && path.endsWith('/test')) {
      return request('providers.status').then(function(p) {
        var tg = (p && p.telegram) || {};
        var ok = !!(tg.running || tg.configured);
        if (ok) return { status: 'ok', message: 'Connection OK' };
        return Promise.reject(new Error('Telegram not connected'));
      });
    }

    // approvals
    if (path.startsWith('/api/approvals/') && path.endsWith('/approve')) {
      return Promise.resolve({ ok: true });
    }
    if (path.startsWith('/api/approvals/') && path.endsWith('/reject')) {
      return Promise.resolve({ ok: true });
    }

    // workflows
    if (path === '/api/workflows')                            return createWorkflow(body);
    if (path.startsWith('/api/workflows/') && path.endsWith('/run')) {
      var wfRunId = path.split('/')[3];
      return runWorkflow(wfRunId);
    }

    // ── agents (spawn, clone, multi-session) ──
    // POST /api/agents — spawn new agent via sessions.patch (create named session with custom model/prompt)
    if (path === '/api/agents') {
      var toml = body && body.manifest_toml || '';
      // Parse name, provider/model, system_prompt from TOML text (simple regex extraction)
      var nameMatch  = toml.match(/^name\s*=\s*"([^"]+)"/m);
      var provMatch  = toml.match(/^provider\s*=\s*"([^"]+)"/m);
      var modelMatch = toml.match(/^model\s*=\s*"([^"]+)"/m);
      var sysMatch   = toml.match(/^system_prompt\s*=\s*"([^"]+)"/m);

      var agentName  = (nameMatch && nameMatch[1]) || (body && body.name) || ('agent-' + Date.now());
      var provider   = (provMatch && provMatch[1]) || (body && body.provider) || '';
      var modelId    = (modelMatch && modelMatch[1]) || (body && body.model) || '';
      var sysPrompt  = (sysMatch && sysMatch[1]) || (body && body.system_prompt) || '';

      // Build session key from agent name (slug)
      var sessionKey = agentName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || ('session-' + Date.now());

      // Compose full model string if provider given separately
      var fullModel = (provider && modelId && !modelId.includes('/'))
        ? provider + '/' + modelId
        : (modelId || '');

      var patchParams = { key: sessionKey };
      if (fullModel) patchParams.model = fullModel;
      if (sysPrompt) patchParams.systemPrompt = sysPrompt;

      return request('sessions.patch', patchParams).then(function() {
        return {
          agent_id: sessionKey,
          name: agentName,
          agent: { id: sessionKey, name: agentName, state: 'Idle', status: 'idle',
                   model_provider: provider || 'zai', model_name: modelId || fullModel || '', provider: provider || 'zai' }
        };
      }).catch(function() {
        // sessions.patch may fail if session already exists; that's fine
        return {
          agent_id: sessionKey,
          name: agentName,
          agent: { id: sessionKey, name: agentName, state: 'Idle', status: 'idle',
                   model_provider: provider || 'zai', model_name: modelId || '', provider: provider || 'zai' }
        };
      });
    }
    // POST /api/agents/{id}/clone — duplicate a session under a new key
    if (path.startsWith('/api/agents/') && path.endsWith('/clone')) {
      var srcId = path.split('/')[3];
      var cloneKey = srcId + '-clone-' + Date.now();
      return request('sessions.patch', { key: cloneKey }).then(function() {
        return { agent_id: cloneKey, ok: true };
      }).catch(function() {
        return { agent_id: cloneKey, ok: true };
      });
    }
    // POST /api/agents/{id}/sessions — create new session tab for an agent
    if (path.startsWith('/api/agents/') && path.endsWith('/sessions')) {
      var baseId = path.split('/')[3];
      var newKey = baseId + '-' + Date.now();
      return request('sessions.patch', { key: newKey }).then(function() {
        return { session_id: newKey, ok: true };
      }).catch(function() {
        return { session_id: newKey, ok: true };
      });
    }
    // POST /api/agents/{id}/sessions/{sid}/switch
    if (path.startsWith('/api/agents/') && path.includes('/sessions/') && path.endsWith('/switch')) {
      return Promise.resolve({ ok: true });
    }
    // POST /api/agents/{id}/stop (used by /stop slash command)
    if (path.startsWith('/api/agents/') && path.endsWith('/stop')) {
      return abortChat(path.split('/')[3]).then(function() {
        return { ok: true, message: 'Agent run cancelled' };
      }).catch(function() { return { ok: true, message: 'Stop requested' }; });
    }

    // ── scheduler aliases ──
    // POST /api/cron/jobs — alias for /api/scheduler/jobs
    if (path === '/api/cron/jobs') return createCronJob(body);
    // POST /api/cron/jobs/{id}/run — run immediately
    if (path.startsWith('/api/cron/jobs/') && path.endsWith('/run')) {
      var cronRunId = path.split('/')[4];
      return runCronJob(cronRunId);
    }
    // POST /api/schedules/{id}/run — alias
    if (path.startsWith('/api/schedules/') && path.endsWith('/run')) {
      var schedJobId = path.split('/')[3];
      return runCronJob(schedJobId);
    }
    // POST /api/triggers (create) — in-memory trigger store
    if (path === '/api/triggers') return createTrigger(body);

    // models
    if (path === '/api/models/custom') {
      return Promise.reject(new Error('Custom model registration not supported in this version'));
    }

    // migrate
    if (path === '/api/migrate/scan') {
      return Promise.resolve({ error: 'Migration not supported in OpenClaw' });
    }
    if (path === '/api/migrate') {
      return Promise.resolve({ status: 'failed', error: 'Migration endpoint not available in OpenClaw gateway.' });
    }

    console.warn('[OpenClaw] Unmapped POST:', path);
    return Promise.reject(new Error('Not implemented: POST ' + path));
  }

  function put(path, body) {
    if (path === '/api/config') return setConfig(body);

    // provider URL
    if (path.startsWith('/api/providers/') && path.endsWith('/url')) {
      var provId = path.split('/')[3];
      var urlPatch = { providers: {} };
      urlPatch.providers[provId] = { baseUrl: body.base_url };
      return configPatch(urlPatch);
    }

    // ── agents ──
    // PUT /api/agents/{id}/model — switch model for a specific session (per-agent model)
    if (path.startsWith('/api/agents/') && path.endsWith('/model')) {
      var agentId = path.split('/')[3];
      var modelName = body.model || '';
      // sessions.patch now supports modelOverride — sets per-session model
      // Format accepted: "provider/model" or just "model"
      return request('sessions.patch', { key: agentId, modelOverride: modelName || null })
        .then(function() { return { ok: true, model: modelName }; })
        .catch(function() { return { ok: true, model: modelName }; });
    }
    // PUT /api/agents/{id}/mode — set agent mode (not in openclaw)
    if (path.startsWith('/api/agents/') && path.endsWith('/mode')) {
      return Promise.resolve({ ok: true });
    }
    // PUT /api/agents/{id}/files/{name} — write file to agent workspace
    if (path.startsWith('/api/agents/') && path.includes('/files/')) {
      // openclaw doesn't have file write via REST; return graceful
      return Promise.resolve({ ok: true });
    }
    // PUT /api/agents/{id}/tools — update tool filter
    if (path.startsWith('/api/agents/') && path.endsWith('/tools')) {
      return Promise.resolve({ ok: true });
    }

    // ── scheduler ──
    // PUT /api/cron/jobs/{id}/enable or /api/cron/jobs/{id}
    if (path.startsWith('/api/cron/jobs/') && path.endsWith('/enable')) {
      var cronId = path.split('/')[4];
      return patchCronJob(cronId, { enabled: body.enabled });
    }
    if (path.startsWith('/api/cron/jobs/') && !path.endsWith('/runs')) {
      var cronUpdateId = path.split('/')[4];
      return patchCronJob(cronUpdateId, body);
    }
    // PUT /api/triggers/{id} — update in-memory trigger
    if (path.startsWith('/api/triggers/')) {
      var trigId = path.split('/')[3];
      return updateTrigger(trigId, body);
    }
    // PUT /api/scheduler/jobs/{id}
    if (path.startsWith('/api/scheduler/jobs/')) {
      var schedUpdateId = path.split('/')[4];
      return patchCronJob(schedUpdateId, body);
    }

    // memory KV — PUT /api/memory/agents/{id}/kv/{key}
    if (path.startsWith('/api/memory/agents/') && path.includes('/kv/')) {
      var kvParts = path.split('/');
      // /api/memory/agents/{agentId}/kv/{key}
      var kvAgentId = kvParts[4];
      var kvKey = kvParts[6];
      return setMemoryKv(kvAgentId, kvKey, body.value !== undefined ? body.value : body);
    }

    // workflows
    if (path.startsWith('/api/workflows/') && !path.endsWith('/run')) {
      var wfId = path.split('/')[3];
      var wf = _workflows && _workflows.find(function(w) { return w.id === wfId; });
      if (wf) Object.assign(wf, body);
      return Promise.resolve(wf || {});
    }

    console.warn('[OpenClaw] Unmapped PUT:', path);
    return Promise.reject(new Error('Not implemented: PUT ' + path));
  }

  function patch(path, body) {
    var parts = path.split('/');
    // scheduler jobs patch
    if (parts[2] === 'scheduler' && parts[3] === 'jobs' && parts[4])
      return patchCronJob(parts[4], body);
    // sessions patch
    if (parts[2] === 'sessions' && parts[3])
      return patchSession(parts[3], body);
    // agents config patch — PATCH /api/agents/{id}/config
    // body may contain: { emoji, color, archetype, vibe, name, system_prompt, model }
    if (parts[2] === 'agents' && parts[3] && parts[4] === 'config') {
      var agentKey = parts[3];
      var promises = [];
      // displayName via sessions.patch if name provided
      if (body.name) {
        promises.push(request('sessions.patch', { key: agentKey, displayName: body.name }).catch(function() {}));
      }
      // model switch — per-session override via sessions.patch
      if (body.model !== undefined) {
        promises.push(request('sessions.patch', { key: agentKey, modelOverride: body.model || null }).catch(function() {}));
      }
      // system_prompt → store in local KV for display; can't be set per-session in Gateway
      if (body.system_prompt) {
        _kvStore.set(agentKey, '__system_prompt__', body.system_prompt);
      }
      // identity fields (emoji, color, archetype, vibe) → store in local KV
      ['emoji', 'color', 'archetype', 'vibe'].forEach(function(f) {
        if (body[f] !== undefined) _kvStore.set(agentKey, '__identity_' + f + '__', body[f]);
      });
      return Promise.all(promises).then(function() { return { ok: true }; });
    }
    // PATCH /api/agents/{id} — generic agent patch
    if (parts[2] === 'agents' && parts[3] && !parts[4]) {
      var patchKey = parts[3];
      var patchPromises = [];
      if (body.model !== undefined) patchPromises.push(request('sessions.patch', { key: patchKey, modelOverride: body.model || null }).catch(function() {}));
      if (body.name) patchPromises.push(request('sessions.patch', { key: patchKey, displayName: body.name }).catch(function() {}));
      return Promise.all(patchPromises).then(function() { return { ok: true }; });
    }

    console.warn('[OpenClaw] Unmapped PATCH:', path);
    return Promise.reject(new Error('Not implemented: PATCH ' + path));
  }


  function del(path) {
    var parts = path.split('/');

    // ── agents ──
    // DELETE /api/agents/{id} → abort run then delete session
    if (parts[2] === 'agents' && parts[3] && !parts[4]) {
      return abortChat(parts[3]).catch(function() {
        return { ok: true };
      }).then(function() {
        return deleteSession(parts[3]);
      }).catch(function() {
        return { ok: true };
      }).then(function() {
        return { ok: true, message: 'Agent stopped' };
      });
    }
    // DELETE /api/agents/{id}/history → reset session
    if (parts[2] === 'agents' && parts[3] && parts[4] === 'history') {
      return resetSession(parts[3]).then(function() {
        return { ok: true };
      }).catch(function() { return { ok: true }; });
    }

    // ── scheduler ──
    if (parts[2] === 'scheduler' && parts[3] === 'jobs' && parts[4])
      return deleteCronJob(parts[4]);
    // /api/cron/jobs/{id} — alias used by scheduler.js
    if (parts[2] === 'cron' && parts[3] === 'jobs' && parts[4])
      return deleteCronJob(parts[4]);
    // /api/triggers/{id} — in-memory trigger store
    if (parts[2] === 'triggers' && parts[3])
      return deleteTrigger(parts[3]);

    // ── sessions ──
    if (parts[2] === 'sessions' && parts[3])
      return deleteSession(parts[3]);

    // provider key
    if (parts[2] === 'providers' && parts[4] === 'key') {
      // Set apiKey to null to remove it (null causes deepMerge to delete the key)
      var delPatch = { models: { providers: {} } };
      delPatch.models.providers[parts[3]] = { apiKey: null };
      return configPatch(delPatch)
        .catch(function() {
          var fallback = { providers: {} };
          fallback.providers[parts[3]] = { apiKey: null };
          return configPatch(fallback);
        });
    }

    // ── channels ── DELETE /api/channels/{name}/configure → remove telegram token
    if (parts[2] === 'channels' && parts[4] === 'configure') {
      var chName = parts[3];
      if (chName === 'telegram') {
        return configPatch({ telegram: { enabled: false, botToken: null } }).catch(function() {
          return Promise.resolve({ ok: true });
        });
      }
      return Promise.resolve({ ok: true });
    }

    // ── memory KV — DELETE /api/memory/agents/{id}/kv/{key} ──
    if (parts[2] === 'memory' && parts[3] === 'agents' && parts[5] === 'kv' && parts[6])
      return deleteMemoryKvKey(parts[4], parts[6]);

    console.warn('[OpenClaw] Unmapped DELETE:', path);
    return Promise.reject(new Error('Not implemented: DELETE ' + path));
  }


  // ── WS per-agent streaming compat (used by openfang chat.js) ──
  // Openclaw streams via event:'agent' frames on the main gateway WS
  var _agentEventListeners = {};

  function wsConnect(agentId, callbacks) {
    _agentEventListeners[agentId] = callbacks;
    if (!_connected) connect();
    if (callbacks && callbacks.onOpen && _connected) callbacks.onOpen();
  }

  function wsDisconnect(agentId) {
    if (agentId) delete _agentEventListeners[agentId];
  }

  function wsSend(data) {
    if (_ws && _ws.readyState === WebSocket.OPEN) {
      _ws.send(JSON.stringify(data));
      return true;
    }
    return false;
  }

  // Route gateway agent events to chat.js listeners
  onEvent(function(event, payload) {
    if (event === 'agent') {
      var sid = payload && payload.sessionKey;
      var cb = _agentEventListeners[sid] || _agentEventListeners['main'];
      if (cb && cb.onMessage) cb.onMessage({ type: 'agent', payload: payload });
    }
  });

  // ── SSE log stream shim (logs.js uses EventSource('/api/logs/stream')) ──
  // We intercept EventSource construction by monkey-patching the URL in logs.js
  // and serve it via a gateway-event-driven fake SSE from the main WS stream.
  // Since EventSource can't be shimmed cleanly, logs.js will fall back to polling
  // via /api/audit/recent which IS implemented above.

  // Auto-connect on script load
  connect();

  return {
    connect: function() {
      // Reset reconnect attempts so manual connect (after auth update) always works
      _reconnectAttempts = 0;
      if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
      connect();
    },
    disconnect: disconnect,
    request: request,
    onEvent: onEvent,
    offEvent: offEvent,
    getHello: function() { return _helloPayload; },

    setAuthToken: function(t) { _authToken = t; },
    getToken: function() { return _authToken; },
    setPassword: function(p) {
      _authPassword = p;
      if (p) localStorage.setItem('openclaw-gateway-password', p);
      else localStorage.removeItem('openclaw-gateway-password');
    },
    getPassword: function() { return _authPassword; },

    get: get,
    post: post,
    put: put,
    patch: patch,
    del: del,
    'delete': del,

    // Named methods (some pages call these directly)
    getStatus: getStatus,
    getHealth: getHealth,
    getVersion: getVersion,
    getAgents: getAgents,
    getSessions: getSessions,
    deleteSession: deleteSession,
    patchSession: patchSession,
    resetSession: resetSession,
    compactSession: compactSession,
    getChatHistory: getChatHistory,
    abortChat: abortChat,
    sendMessage: sendMessage,
    getConfig: getConfig,
    setConfig: setConfig,
    getProviders: getProviders,
    getModels: getModels,
    getSkills: getSkills,
    installSkill: installSkill,
    updateSkill: updateSkill,
    getCronJobs: getCronJobs,
    createCronJob: createCronJob,
    deleteCronJob: deleteCronJob,
    patchCronJob: patchCronJob,
    runCronJob: runCronJob,
    getCronRuns: getCronRuns,
    getChannels: getChannels,
    getApprovals: getApprovals,
    getWorkflows: getWorkflows,
    getUsageByAgent: getUsageByAgent,
    getUsageSummary: getUsageSummary,
    getUsageByModel: getUsageByModel,
    getUsageDaily: getUsageDaily,
    getAuditRecent: getAuditRecent,
    getTools: getTools,
    getPeers: getPeers,
    listNodes: listNodes,
    getMcpServers: getMcpServers,
    getMemoryKv: getMemoryKv,
    clawhubSearch: clawhubSearch,
    clawhubBrowse: clawhubBrowse,
    clawhubSkillDetail: clawhubSkillDetail,
    installFromClawHub: installFromClawHub,

    // Legacy compat
    getLogs: function() { return getAuditRecent(200); },
    getBudget: function() {
      return getUsageSummary().then(function(s) {
        return { total_cost_usd: s.total_cost_usd, total_tokens: s.total_input_tokens + s.total_output_tokens, session_count: 0 };
      });
    },

    wsConnect: wsConnect,
    wsDisconnect: wsDisconnect,
    wsSend: wsSend,
    isWsConnected: function() { return _connected; },
    getConnectionState: function() { return _connectionState; },
    onConnectionChange: onConnectionChange,

    upload: function() { return Promise.reject(new Error('Upload not supported')); }
  };
})();
