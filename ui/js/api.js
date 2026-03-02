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
  var _instanceId = 'ui-' + Math.random().toString(36).slice(2);
  var _connected = false;
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
          auth: _authToken ? { token: _authToken } : undefined
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
      if (e.code !== 1000) {
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
        return {
          id: s.key || s.sessionKey || 'main',
          name: s.key || s.sessionKey || 'Session',
          status: s.abortedLastRun ? 'error' : 'idle',
          model: model,
          provider: model ? model.split('/')[0] : 'zai',
          created_at: s.updatedAt ? new Date(s.updatedAt).toISOString() : null,
          last_active: s.updatedAt ? new Date(s.updatedAt).toISOString() : null,
          message_count: s.totalTokens || 0,
          session_id: s.sessionId || '',
          token_count: s.totalTokens || 0,
          context_tokens: s.contextTokens || defaults.contextTokens || 0,
          percent_used: s.percentUsed || 0
        };
      });
    }).catch(function() {
      return [{ id: 'main', name: 'DevOps Agent', status: 'idle', provider: 'zai' }];
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

  // sessions.list returns key as s.key — but gateway methods expect { sessionKey }
  function deleteSession(key) {
    return request('sessions.delete', { sessionKey: key });
  }

  function patchSession(key, patch) {
    return request('sessions.patch', Object.assign({ sessionKey: key }, patch));
  }

  function resetSession(key) {
    return request('sessions.reset', { sessionKey: key });
  }

  function compactSession(key) {
    return request('sessions.compact', { sessionKey: key });
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

  function setConfig(patch) {
    // Support both { patch: {...} } and direct object
    if (patch && typeof patch === 'object' && !patch.patch) {
      return request('config.set', { patch: patch });
    }
    return request('config.set', { patch: patch.patch || patch });
  }

  function getConfigSchema() {
    // Gateway has no schema endpoint; return empty
    return Promise.resolve({ sections: null });
  }

  // providers — built from providers.status (Telegram-only in openclaw)
  function getProviders() {
    return request('providers.status').then(function(p) {
      var providers = [];
      if (p && p.telegram) {
        var tg = p.telegram;
        providers.push({
          id: 'telegram',
          display_name: 'Telegram',
          auth_status: tg.configured ? 'configured' : 'not_set',
          health: tg.running ? 'ok' : (tg.lastError ? 'open' : 'ok'),
          is_local: false,
          mode: tg.mode,
          last_error: tg.lastError || null
        });
      }
      return { providers: providers };
    }).catch(function() { return { providers: [] }; });
  }

  // models
  function getModels() {
    return request('models.list').then(function(p) {
      var models = (p && p.models) || [];
      return {
        models: models.map(function(m) {
          return {
            id: m.id || m.modelId || m,
            display_name: m.displayName || m.name || m.id || m,
            provider: m.provider || (typeof m === 'string' && m.split('/')[0]) || 'zai',
            tier: _inferModelTier(m.id || m.modelId || m),
            context_window: m.contextWindow || m.contextLength || 128000,
            max_output_tokens: m.maxOutputTokens || 8192,
            input_cost: m.inputCostPer1M || null,
            output_cost: m.outputCostPer1M || null
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

  // tools — derive from connected skills
  function getTools() {
    return getSkills().then(function(data) {
      var tools = [];
      (data.skills || []).forEach(function(s) {
        if (s.tools_count > 0) {
          tools.push({
            name: s.name,
            description: s.description || '',
            source: s.name,
            enabled: s.enabled !== false
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
    return request('providers.status').then(function(p) {
      var channels = [];
      if (p && p.telegram) {
        var tg = p.telegram;
        channels.push({
          name: 'telegram',
          display_name: 'Telegram',
          description: 'Receive and send messages via Telegram bot',
          category: 'messaging',
          configured: tg.configured,
          has_token: tg.configured,
          connected: tg.running && tg.configured,
          setup_type: 'form',
          difficulty: 'Easy',
          fields: [{ key: 'bot_token', label: 'Bot Token', type: 'password', advanced: false }]
        });
      }
      return { channels: channels };
    }).catch(function() { return { channels: [] }; });
  }

  // approvals — openclaw uses chat.abort as closest equivalent; no native approval queue
  // Return empty list (not an error) — page renders "no pending approvals"
  function getApprovals() {
    return Promise.resolve({ approvals: [] });
  }

  // workflows — not implemented in openclaw gateway; return empty gracefully
  function getWorkflows() {
    return Promise.resolve([]);
  }

  function createWorkflow() {
    return Promise.reject(new Error('Workflows not supported in this version'));
  }

  function runWorkflow() {
    return Promise.reject(new Error('Workflows not supported in this version'));
  }

  // mcp servers — not implemented; return empty
  function getMcpServers() {
    return Promise.resolve({ configured: [], connected: [], total_configured: 0, total_connected: 0 });
  }

  // memory KV — session-level KV not in gateway; return empty
  function getMemoryKv() {
    return Promise.resolve({ kv_pairs: [] });
  }

  function setMemoryKv() {
    return Promise.reject(new Error('Memory KV not supported in this version'));
  }

  function deleteMemoryKv() {
    return Promise.reject(new Error('Memory KV not supported in this version'));
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

    // scheduler / cron
    if (path === '/api/scheduler/jobs')    return getCronJobs();
    if (path.startsWith('/api/scheduler/jobs/') && path.endsWith('/runs')) {
      var jobId = path.split('/')[4];
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

    // tools
    if (path === '/api/tools')             return getTools();

    // GitHub Copilot OAuth poll
    if (path.startsWith('/api/providers/github-copilot/oauth/poll/')) {
      return Promise.resolve({ status: 'expired' });
    }

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
    if (path === '/api/config/set')        return request('config.set', { patch: body });

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

    // providers
    if (path.startsWith('/api/providers/') && path.endsWith('/key')) {
      var provId = path.split('/')[3];
      return request('config.set', { patch: { providers: { [provId]: { apiKey: body.key } } } });
    }
    if (path.startsWith('/api/providers/') && path.endsWith('/test')) {
      return request('providers.status', { probe: true }).then(function() {
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
        return request('config.set', { patch: { telegram: body.fields } });
      }
      return Promise.reject(new Error('Channel ' + chName + ' not supported'));
    }
    if (path.startsWith('/api/channels/') && path.endsWith('/test')) {
      return request('providers.status', { probe: true }).then(function() {
        return { status: 'ok', message: 'Connection OK' };
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
    if (path.startsWith('/api/workflows/') && path.endsWith('/run'))  return runWorkflow();

    // models
    if (path === '/api/models/custom') {
      return Promise.reject(new Error('Custom model registration not supported in this version'));
    }

    console.warn('[OpenClaw] Unmapped POST:', path);
    return Promise.reject(new Error('Not implemented: POST ' + path));
  }

  function put(path, body) {
    if (path === '/api/config') return setConfig(body);

    // provider URL
    if (path.startsWith('/api/providers/') && path.endsWith('/url')) {
      var provId = path.split('/')[3];
      return request('config.set', { patch: { providers: { [provId]: { baseUrl: body.base_url } } } });
    }

    // memory KV
    if (path.startsWith('/api/memory/agents/') && path.includes('/kv/')) {
      return setMemoryKv(path, body);
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

    console.warn('[OpenClaw] Unmapped PATCH:', path);
    return Promise.reject(new Error('Not implemented: PATCH ' + path));
  }

  function del(path) {
    var parts = path.split('/');
    // scheduler
    if (parts[2] === 'scheduler' && parts[3] === 'jobs' && parts[4])
      return deleteCronJob(parts[4]);
    // sessions
    if (parts[2] === 'sessions' && parts[3])
      return deleteSession(parts[3]);
    // provider key
    if (parts[2] === 'providers' && parts[4] === 'key')
      return request('config.set', { patch: { providers: { [parts[3]]: { apiKey: '' } } } });
    // channels
    if (parts[2] === 'channels' && parts[4] === 'configure')
      return Promise.resolve({ ok: true });
    // memory KV
    if (parts[2] === 'memory' && parts[3] === 'agents' && parts[5] === 'kv' && parts[6])
      return deleteMemoryKv();

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
    connect: connect,
    disconnect: disconnect,
    request: request,
    onEvent: onEvent,
    offEvent: offEvent,
    getHello: function() { return _helloPayload; },

    setAuthToken: function(t) { _authToken = t; },
    getToken: function() { return _authToken; },

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
