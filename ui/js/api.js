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

  // ── High-level API — maps openfang REST paths to Gateway WS methods ──

  function getStatus() {
    return request('health').then(function(payload) {
      return {
        version: (payload && payload.version) || '?',
        agent_count: 0,
        connected: true,
        status: 'ok'
      };
    });
  }

  function getAgents() {
    return request('sessions.list').then(function(payload) {
      var sessions = (payload && payload.sessions) || [];
      return sessions.map(function(s) {
        return {
          id: s.sessionKey || s.id || 'main',
          name: s.sessionKey || 'Session',
          status: s.running ? 'running' : 'idle',
          model: s.model || '',
          provider: s.provider || 'anthropic',
          created_at: s.createdAt || null,
          last_active: s.lastActiveAt || null,
          message_count: s.messageCount || 0
        };
      });
    }).catch(function() {
      return [{ id: 'main', name: 'DevOps Agent', status: 'idle', provider: 'anthropic' }];
    });
  }

  function getConfig() {
    return request('config.get').then(function(p) { return p || {}; }).catch(function() { return {}; });
  }

  function setConfig(patch) {
    return request('config.set', { patch: patch });
  }

  function getSessions() {
    return request('sessions.list').then(function(p) { return (p && p.sessions) || []; }).catch(function() { return []; });
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

  function getLogs() {
    return Promise.resolve({ entries: [], total: 0 });
  }

  function getSkills() {
    return request('skills.status').then(function(p) { return (p && p.skills) || []; }).catch(function() { return []; });
  }

  function getCronJobs() {
    return request('cron.list').then(function(p) { return (p && p.jobs) || []; }).catch(function() { return []; });
  }

  function createCronJob(job) { return request('cron.create', job); }
  function deleteCronJob(id) { return request('cron.delete', { id: id }); }
  function patchCronJob(id, patch) { return request('cron.patch', Object.assign({ id: id }, patch)); }

  function getBudget() {
    return Promise.resolve({ total_cost_usd: 0, total_tokens: 0, session_count: 0 });
  }

  // ── REST-compat shim (used by openfang page modules as-is) ──
  function get(path) {
    if (path === '/api/status')          return getStatus();
    if (path === '/api/agents')          return getAgents();
    if (path === '/api/config')          return getConfig();
    if (path === '/api/budget')          return getBudget();
    if (path === '/api/skills')          return getSkills();
    if (path === '/api/scheduler/jobs')  return getCronJobs();
    if (path === '/api/logs')            return getLogs();
    if (path.startsWith('/api/agents/') && path.endsWith('/sessions'))
      return getSessions();
    return getStatus();
  }

  function post(path, body) {
    if (path.startsWith('/api/agents/') && path.endsWith('/message')) {
      var agentId = path.split('/')[3];
      return sendMessage(agentId, body.message, body);
    }
    if (path === '/api/scheduler/jobs') return createCronJob(body);
    if (path === '/api/config')         return setConfig(body);
    return Promise.reject(new Error('Not implemented: POST ' + path));
  }

  function put(path, body) {
    if (path === '/api/config') return setConfig(body);
    return Promise.reject(new Error('Not implemented: PUT ' + path));
  }

  function patch(path, body) {
    var parts = path.split('/');
    if (parts[2] === 'scheduler' && parts[3] === 'jobs' && parts[4])
      return patchCronJob(parts[4], body);
    return Promise.reject(new Error('Not implemented: PATCH ' + path));
  }

  function del(path) {
    var parts = path.split('/');
    if (parts[2] === 'scheduler' && parts[3] === 'jobs' && parts[4])
      return deleteCronJob(parts[4]);
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

    getStatus: getStatus,
    getAgents: getAgents,
    getConfig: getConfig,
    setConfig: setConfig,
    getSessions: getSessions,
    sendMessage: sendMessage,
    getLogs: getLogs,
    getSkills: getSkills,
    getCronJobs: getCronJobs,
    createCronJob: createCronJob,
    deleteCronJob: deleteCronJob,
    patchCronJob: patchCronJob,
    getBudget: getBudget,

    wsConnect: wsConnect,
    wsDisconnect: wsDisconnect,
    wsSend: wsSend,
    isWsConnected: function() { return _connected; },
    getConnectionState: function() { return _connectionState; },
    onConnectionChange: onConnectionChange,

    upload: function() { return Promise.reject(new Error('Upload not supported')); }
  };
})();
