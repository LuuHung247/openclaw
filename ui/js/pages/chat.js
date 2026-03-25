// OpenFang Chat Page — Agent chat with markdown + streaming
'use strict';

// Parse "provider/model-name" or "model-name" → display name without provider prefix
function parseModelName(model) {
  if (!model) return '';
  var idx = model.indexOf('/');
  return idx >= 0 ? model.slice(idx + 1) : model;
}

// Extract <think>...</think> content and return { thinking, text }.
// Handles both closed tags and unclosed (still-streaming) open tag at end of text.
function extractThinking(raw) {
  if (!raw || raw.indexOf('<think>') === -1) return { thinking: '', text: raw || '' };
  var thinking = '';
  var text = raw;

  // Closed blocks: <think>...</think>
  var closedRe = /<think>([\s\S]*?)<\/think>/g;
  var m;
  while ((m = closedRe.exec(raw)) !== null) thinking += m[1];
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '');

  // Unclosed open tag (still streaming): everything after last <think>
  var openIdx = text.lastIndexOf('<think>');
  if (openIdx !== -1) {
    thinking += text.slice(openIdx + 7);
    text = text.slice(0, openIdx);
  }

  return { thinking: thinking.trim(), text: text.replace(/^\s+/, '') };
}

function chatPage() {
  var msgId = 0;
  return {
    currentAgent: null,
    // messages proxied through Alpine store so they survive tab navigation
    get messages() { return Alpine.store('app').chatMessages; },
    set messages(v) { Alpine.store('app').chatMessages = v; },
    inputText: '',
    sending: false,
    messageQueue: [],    // Queue for messages sent while streaming
    thinkingMode: 'off', // 'off' | 'on' | 'stream'
    _wsAgent: null,
    showSlashMenu: false,
    slashFilter: '',
    slashIdx: 0,
    attachments: [],
    dragOver: false,
    contextPressure: 'low', // green/yellow/orange/red indicator
    _typingTimeout: null,
    // Multi-session state
    sessions: [],
    sessionsOpen: false,
    searchOpen: false,
    searchQuery: '',
    // Voice recording state
    recording: false,
    _mediaRecorder: null,
    _audioChunks: [],
    recordingTime: 0,
    _recordingTimer: null,
    // Model autocomplete state
    showModelPicker: false,
    modelPickerList: [],
    modelPickerFilter: '',
    modelPickerIdx: 0,
    // Model switcher (footer dropdown)
    showModelSwitcher: false,
    modelSwitcherFilter: '',
    modelSwitcherProviderFilter: '',
    modelSwitcherIdx: 0,
    modelSwitching: false,
    _modelCache: null,
    _modelCacheTime: 0,
    slashCommands: [
      { cmd: '/help', desc: 'Show available commands' },
      { cmd: '/agents', desc: 'Switch to Agents page' },
      { cmd: '/new', desc: 'Reset session (clear history)' },
      { cmd: '/compact', desc: 'Trigger LLM session compaction' },
      { cmd: '/model', desc: 'Show or switch model (/model [name])' },
      { cmd: '/usage', desc: 'Show session token usage & cost' },
      { cmd: '/think', desc: 'Toggle extended thinking (/think [on|off|stream])' },
      { cmd: '/context', desc: 'Show context window usage & pressure' },
      { cmd: '/verbose', desc: 'Cycle tool detail level (/verbose [off|on|full])' },
      { cmd: '/queue', desc: 'Check if agent is processing' },
      { cmd: '/status', desc: 'Show system status' },
      { cmd: '/clear', desc: 'Clear chat display' },
      { cmd: '/exit', desc: 'Disconnect from agent' },
      { cmd: '/budget', desc: 'Show spending limits and current costs' },
      { cmd: '/peers', desc: 'Show OFP peer network status' },
      { cmd: '/a2a', desc: 'List discovered external A2A agents' }
    ],
    tokenCount: 0,

    // ── Tip Bar ──
    tipIndex: 0,
    tips: ['Type / for commands', '/think on for reasoning', 'Ctrl+Shift+F for focus mode', 'Drag files to attach', '/model to switch models', '/context to check usage', '/verbose off to hide tool details'],
    tipTimer: null,
    get currentTip() {
      if (localStorage.getItem('of-tips-off') === 'true') return '';
      return this.tips[this.tipIndex % this.tips.length];
    },
    dismissTips: function() { localStorage.setItem('of-tips-off', 'true'); },
    startTipCycle: function() {
      var self = this;
      if (this.tipTimer) clearInterval(this.tipTimer);
      this.tipTimer = setInterval(function() {
        self.tipIndex = (self.tipIndex + 1) % self.tips.length;
      }, 30000);
    },

    // Backward compat helper
    get thinkingEnabled() { return this.thinkingMode !== 'off'; },

    // Context pressure dot color
    get contextDotColor() {
      switch (this.contextPressure) {
        case 'critical': return '#ef4444';
        case 'high': return '#f97316';
        case 'medium': return '#eab308';
        default: return '#22c55e';
      }
    },

    // Model switcher computed
    get modelDisplayName() {
      if (!this.currentAgent) return '';
      var name = this.currentAgent.model_name || '';
      var short = name.replace(/-\d{8}$/, '');
      return short.length > 24 ? short.substring(0, 22) + '\u2026' : short;
    },
    get switcherProviders() {
      var seen = {};
      (this._modelCache || []).forEach(function(m) { seen[m.provider] = true; });
      return Object.keys(seen).sort();
    },
    get filteredSwitcherModels() {
      var models = this._modelCache || [];
      var provFilter = this.modelSwitcherProviderFilter;
      var textFilter = this.modelSwitcherFilter ? this.modelSwitcherFilter.toLowerCase() : '';
      if (!provFilter && !textFilter) return models;
      return models.filter(function(m) {
        if (provFilter && m.provider !== provFilter) return false;
        if (textFilter) {
          return m.id.toLowerCase().indexOf(textFilter) !== -1 ||
                 (m.display_name || '').toLowerCase().indexOf(textFilter) !== -1 ||
                 m.provider.toLowerCase().indexOf(textFilter) !== -1;
        }
        return true;
      });
    },
    get groupedSwitcherModels() {
      var filtered = this.filteredSwitcherModels;
      var groups = {}, order = [];
      filtered.forEach(function(m) {
        if (!groups[m.provider]) { groups[m.provider] = []; order.push(m.provider); }
        groups[m.provider].push(m);
      });
      return order.map(function(p) {
        return { provider: p.charAt(0).toUpperCase() + p.slice(1), models: groups[p] };
      });
    },

    init() {
      var self = this;

      // Start tip cycle
      this.startTipCycle();

      // Fetch dynamic commands from server
      this.fetchCommands();

      // Ctrl+/ keyboard shortcut
      document.addEventListener('keydown', function(e) {
        if ((e.ctrlKey || e.metaKey) && e.key === '/') {
          e.preventDefault();
          var input = document.getElementById('msg-input');
          if (input) { input.focus(); self.inputText = '/'; }
        }
        // Ctrl+M for model switcher
        if ((e.ctrlKey || e.metaKey) && e.key === 'm' && self.currentAgent) {
          e.preventDefault();
          self.toggleModelSwitcher();
        }
        // Ctrl+F for chat search
        if ((e.ctrlKey || e.metaKey) && e.key === 'f' && self.currentAgent) {
          e.preventDefault();
          self.toggleSearch();
        }
      });

      // Load session list when agent changes.
      // History is loaded by connectWs.onOpen via loadChatHistory (single source of truth).
      this.$watch('currentAgent', function(agent) {
        if (agent) {
          self.loadSessions(agent.id);
        }
      });

      // Check for pending agent from Agents page (set before chat mounted)
      var store = Alpine.store('app');
      if (store.pendingAgent) {
        self.selectAgent(store.pendingAgent);
        store.pendingAgent = null;
      } else {
        // Auto-load first available agent (standalone chat page)
        self.autoLoadAgent();
      }

      // Listen for model changes from Settings page — chỉ thông báo, KHÔNG đổi model session
      window.addEventListener('openclaw:model-changed', function(e) {
        var newDefault = (e.detail && e.detail.model) || '';
        if (!newDefault) return;
        var displayModel = parseModelName(newDefault) || newDefault;
        self.messages.push({
          id: ++msgId, role: 'system',
          text: 'Default model changed to **' + displayModel + '**. Your current session keeps its model. Use `/model ' + newDefault + '` to switch this session.',
          meta: '', tools: []
        });
        self.scrollToBottom();
      });

      // Watch for future pending agent selections (e.g., user clicks agent while on chat)
      this.$watch('$store.app.pendingAgent', function(agent) {
        if (agent) {
          self.selectAgent(agent);
          Alpine.store('app').pendingAgent = null;
        }
      });

      // Watch for slash commands + model autocomplete
      this.$watch('inputText', function(val) {
        var modelMatch = val.match(/^\/model\s+(.*)$/i);
        if (modelMatch) {
          self.showSlashMenu = false;
          self.modelPickerFilter = modelMatch[1].toLowerCase();
          if (!self.modelPickerList.length) {
            OpenFangAPI.get('/api/models').then(function(data) {
              self.modelPickerList = (data.models || []).filter(function(m) { return m.available; });
              self.showModelPicker = true;
              self.modelPickerIdx = 0;
            }).catch(function() {});
          } else {
            self.showModelPicker = true;
          }
        } else if (val.startsWith('/')) {
          self.showModelPicker = false;
          self.slashFilter = val.slice(1).toLowerCase();
          self.showSlashMenu = true;
          self.slashIdx = 0;
        } else {
          self.showSlashMenu = false;
          self.showModelPicker = false;
        }
      });
    },

    get filteredModelPicker() {
      if (!this.modelPickerFilter) return this.modelPickerList.slice(0, 15);
      var f = this.modelPickerFilter;
      return this.modelPickerList.filter(function(m) {
        return m.id.toLowerCase().indexOf(f) !== -1 || (m.display_name || '').toLowerCase().indexOf(f) !== -1 || m.provider.toLowerCase().indexOf(f) !== -1;
      }).slice(0, 15);
    },

    pickModel(modelId) {
      this.showModelPicker = false;
      this.inputText = '/model ' + modelId;
      this.sendMessage();
    },

    // Push a model-switch divider message into chat history (client-only, not persisted)
    pushModelSwitchMessage: function(modelId, provider) {
      var displayName = parseModelName(modelId) || modelId;
      var label = provider ? displayName + ' (' + provider + ')' : displayName;
      this.messages.push({
        id: ++msgId, role: 'model-switch',
        text: 'Set model to ' + label,
        meta: '', tools: []
      });
      this.scrollToBottom();
    },

    toggleModelSwitcher: function() {
      if (this.showModelSwitcher) { this.showModelSwitcher = false; return; }
      var self = this;
      var now = Date.now();
      if (this._modelCache && (now - this._modelCacheTime) < 300000) {
        this.modelSwitcherFilter = '';
        this.modelSwitcherProviderFilter = '';
        this.modelSwitcherIdx = 0;
        this.showModelSwitcher = true;
        this.$nextTick(function() {
          var el = document.getElementById('model-switcher-search') || document.getElementById('model-switcher-search-2');
          if (el) el.focus();
        });
        return;
      }
      OpenFangAPI.get('/api/models').then(function(data) {
        var models = (data.models || []).filter(function(m) { return m.available; });
        self._modelCache = models;
        self._modelCacheTime = Date.now();
        self.modelPickerList = models;
        self.modelSwitcherFilter = '';
        self.modelSwitcherProviderFilter = '';
        self.modelSwitcherIdx = 0;
        self.showModelSwitcher = true;
        self.$nextTick(function() {
          var el = document.getElementById('model-switcher-search') || document.getElementById('model-switcher-search-2');
          if (el) el.focus();
        });
      }).catch(function(e) {
        OpenFangToast.error('Failed to load models: ' + e.message);
      });
    },

    switchModel: function(model) {
      if (!this.currentAgent) return;
      if (model.id === this.currentAgent.model_name) { this.showModelSwitcher = false; return; }
      var self = this;
      this.modelSwitching = true;
      // Send provider/model format so backend knows which provider to use
      var fullModelId = model.provider ? model.provider + '/' + model.id : model.id;
      OpenFangAPI.put('/api/agents/' + this.currentAgent.id + '/model', { model: fullModelId }).then(function(resp) {
        var resolvedProvider = (resp && resp.provider) || model.provider;
        self.currentAgent.model_name = model.id;
        self.currentAgent.model = fullModelId;
        if (resolvedProvider) self.currentAgent.model_provider = resolvedProvider;
        self.pushModelSwitchMessage(model.id, resolvedProvider);
        self.showModelSwitcher = false;
        self.modelSwitching = false;
      }).catch(function(e) {
        OpenFangToast.error('Switch failed: ' + e.message);
        self.modelSwitching = false;
      });
    },

    // Fetch dynamic slash commands from server
    fetchCommands: function() {
      var self = this;
      OpenFangAPI.get('/api/commands').then(function(data) {
        if (data.commands && data.commands.length) {
          // Build a set of known cmds to avoid duplicates
          var existing = {};
          self.slashCommands.forEach(function(c) { existing[c.cmd] = true; });
          data.commands.forEach(function(c) {
            if (!existing[c.cmd]) {
              self.slashCommands.push({ cmd: c.cmd, desc: c.desc || '', source: c.source || 'server' });
              existing[c.cmd] = true;
            }
          });
        }
      }).catch(function() { /* silent — use hardcoded list */ });
    },

    get filteredSlashCommands() {
      if (!this.slashFilter) return this.slashCommands;
      var f = this.slashFilter;
      return this.slashCommands.filter(function(c) {
        return c.cmd.toLowerCase().indexOf(f) !== -1 || c.desc.toLowerCase().indexOf(f) !== -1;
      });
    },

    // Clear any stuck typing indicator after 120s
    _resetTypingTimeout: function() {
      var self = this;
      if (self._typingTimeout) clearTimeout(self._typingTimeout);
      self._typingTimeout = setTimeout(function() {
        // Auto-clear stuck typing indicators
        self.messages = self.messages.filter(function(m) { return !m.thinking; });
        self.sending = false;
      }, 120000);
    },

    _clearTypingTimeout: function() {
      if (this._typingTimeout) {
        clearTimeout(this._typingTimeout);
        this._typingTimeout = null;
      }
    },

    executeSlashCommand(cmd, cmdArgs) {
      this.showSlashMenu = false;
      this.inputText = '';
      var self = this;
      cmdArgs = cmdArgs || '';
      switch (cmd) {
        case '/help':
          self.messages.push({ id: ++msgId, role: 'system', text: self.slashCommands.map(function(c) { return '`' + c.cmd + '` — ' + c.desc; }).join('\n'), meta: '', tools: [] });
          self.scrollToBottom();
          break;
        case '/agents':
          location.hash = 'agents';
          break;
        case '/new':
          if (self.currentAgent) {
            // Gateway openclaw: use sessions.reset via the REST shim path
            OpenFangAPI.post('/api/sessions/' + self.currentAgent.id + '/reset', {}).then(function() {
              self.messages = [];
              OpenFangToast.success('Session reset');
            }).catch(function(e) { OpenFangToast.error('Reset failed: ' + e.message); });
          }
          break;
        case '/compact':
          if (self.currentAgent) {
            self.messages.push({ id: ++msgId, role: 'system', text: 'Compacting session...', meta: '', tools: [] });
            // Gateway openclaw: use sessions.compact via the REST shim path
            OpenFangAPI.post('/api/sessions/' + self.currentAgent.id + '/compact', {}).then(function(res) {
              self.messages.push({ id: ++msgId, role: 'system', text: (res && res.message) || 'Compaction complete', meta: '', tools: [] });
              self.scrollToBottom();
            }).catch(function(e) { OpenFangToast.error('Compaction failed: ' + e.message); });
          }
          break;
        case '/stop':
          if (self.currentAgent) {
            OpenFangAPI.post('/api/agents/' + self.currentAgent.id + '/stop', {}).then(function(res) {
              self.messages.push({ id: ++msgId, role: 'system', text: res.message || 'Run cancelled', meta: '', tools: [] });
              self.sending = false;
              self.scrollToBottom();
            }).catch(function(e) { OpenFangToast.error('Stop failed: ' + e.message); });
          }
          break;
        case '/usage':
          if (self.currentAgent) {
            var approxTokens = self.messages.reduce(function(sum, m) { return sum + Math.round((m.text || '').length / 4); }, 0);
            self.messages.push({ id: ++msgId, role: 'system', text: '**Session Usage**\n- Messages: ' + self.messages.length + '\n- Approx tokens: ~' + approxTokens, meta: '', tools: [] });
            self.scrollToBottom();
          }
          break;
        case '/think':
          if (cmdArgs === 'on') {
            self.thinkingMode = 'on';
          } else if (cmdArgs === 'off') {
            self.thinkingMode = 'off';
          } else if (cmdArgs === 'stream') {
            self.thinkingMode = 'stream';
          } else {
            // Cycle: off -> on -> stream -> off
            if (self.thinkingMode === 'off') self.thinkingMode = 'on';
            else if (self.thinkingMode === 'on') self.thinkingMode = 'stream';
            else self.thinkingMode = 'off';
          }
          var modeLabel = self.thinkingMode === 'stream' ? 'enabled (streaming reasoning)' : (self.thinkingMode === 'on' ? 'enabled' : 'disabled');
          self.messages.push({ id: ++msgId, role: 'system', text: 'Extended thinking **' + modeLabel + '**. ' +
            (self.thinkingMode === 'stream' ? 'Reasoning tokens will appear in a collapsible panel.' :
             self.thinkingMode === 'on' ? 'The agent will show its reasoning when supported by the model.' :
             'Normal response mode.'), meta: '', tools: [] });
          self.scrollToBottom();
          break;
        case '/context':
          if (self.currentAgent) {
            OpenFangAPI.getSessions().then(function(res) {
              var list = (res && res.sessions) || [];
              var s = list.find(function(x) { return x.agent_id === self.currentAgent.id || x.session_key === self.currentAgent.id; });
              var used = s ? (s.context_tokens || 0) : 0;
              var pct = s ? (s.context_pct || 0).toFixed(1) : '?';
              self.messages.push({ id: ++msgId, role: 'system', text: '**Context Window**\n- Used: ' + used.toLocaleString() + ' tokens\n- Pressure: ' + pct + '%', meta: '', tools: [] });
              self.scrollToBottom();
            }).catch(function() {
              self.messages.push({ id: ++msgId, role: 'system', text: 'Could not fetch context info.', meta: '', tools: [] });
              self.scrollToBottom();
            });
          } else {
            self.messages.push({ id: ++msgId, role: 'system', text: 'Not connected. Connect to an agent first.', meta: '', tools: [] });
            self.scrollToBottom();
          }
          break;
        case '/verbose':
          if (self.currentAgent) {
            var newLevel;
            if (cmdArgs === 'off' || cmdArgs === 'on' || cmdArgs === 'full') {
              newLevel = cmdArgs;
            } else {
              var cur = self.currentAgent.verboseLevel || 'off';
              newLevel = cur === 'off' ? 'on' : cur === 'on' ? 'full' : 'off';
            }
            var patchVal = newLevel === 'off' ? null : newLevel;
            OpenFangAPI.request('sessions.patch', { key: self.currentAgent.id, verboseLevel: patchVal }).then(function() {
              if (self.currentAgent) self.currentAgent.verboseLevel = newLevel;
              self.messages.push({ id: ++msgId, role: 'system', text: 'Verbose level set to **' + newLevel + '**', meta: '', tools: [] });
              self.scrollToBottom();
            }).catch(function(e) {
              self.messages.push({ id: ++msgId, role: 'system', text: 'Failed to set verbose: ' + (e && e.message || String(e)), meta: '', tools: [] });
              self.scrollToBottom();
            });
          } else {
            self.messages.push({ id: ++msgId, role: 'system', text: 'Not connected. Connect to an agent first.', meta: '', tools: [] });
            self.scrollToBottom();
          }
          break;
        case '/queue':
          if (self.currentAgent) {
            OpenFangAPI.getSessions().then(function(res) {
              var list = (res && res.sessions) || [];
              var s = list.find(function(x) { return x.agent_id === self.currentAgent.id || x.session_key === self.currentAgent.id; });
              var state = s ? (s.running ? 'running' : 'idle') : 'unknown';
              self.messages.push({ id: ++msgId, role: 'system', text: '**Agent Queue**\n- State: ' + state + '\n- Processing: ' + (state === 'running' ? 'Yes' : 'No'), meta: '', tools: [] });
              self.scrollToBottom();
            }).catch(function() {
              self.messages.push({ id: ++msgId, role: 'system', text: 'Could not fetch queue status.', meta: '', tools: [] });
              self.scrollToBottom();
            });
          } else {
            self.messages.push({ id: ++msgId, role: 'system', text: 'Not connected.', meta: '', tools: [] });
            self.scrollToBottom();
          }
          break;
        case '/status':
          OpenFangAPI.get('/api/status').then(function(s) {
            self.messages.push({ id: ++msgId, role: 'system', text: '**System Status**\n- Agents: ' + (s.agent_count || 0) + '\n- Uptime: ' + (s.uptime_seconds || 0) + 's\n- Version: ' + (s.version || '?'), meta: '', tools: [] });
            self.scrollToBottom();
          }).catch(function() {});
          break;
        case '/model':
          if (self.currentAgent) {
            if (cmdArgs) {
              OpenFangAPI.put('/api/agents/' + self.currentAgent.id + '/model', { model: cmdArgs }).then(function(resp) {
                var resolvedModel = (resp && resp.model) || cmdArgs;
                var resolvedProvider = (resp && resp.provider) || '';
                self.currentAgent.model = resolvedModel;
                self.currentAgent.model_name = parseModelName(resolvedModel);
                self.pushModelSwitchMessage(resolvedModel, resolvedProvider);
              }).catch(function(e) { OpenFangToast.error('Model switch failed: ' + e.message); });
            } else {
              var model = self.currentAgent.model || '?';
              var displayModel = parseModelName(model) || model;
              self.messages.push({ id: ++msgId, role: 'system', text: '**Current Model**: `' + displayModel + '` (`' + model + '`)', meta: '', tools: [] });
              self.scrollToBottom();
            }
          } else {
            self.messages.push({ id: ++msgId, role: 'system', text: 'No agent selected.', meta: '', tools: [] });
            self.scrollToBottom();
          }
          break;
        case '/clear':
          self.messages = [];
          break;
        case '/exit':
          OpenFangAPI.wsDisconnect();
          self._wsAgent = null;
          self.currentAgent = null;
          self.messages = [];
          window.dispatchEvent(new Event('close-chat'));
          break;
        case '/budget':
          OpenFangAPI.get('/api/budget').then(function(b) {
            var fmt = function(v) { return v > 0 ? '$' + v.toFixed(2) : 'unlimited'; };
            self.messages.push({ id: ++msgId, role: 'system', text: '**Budget Status**\n' +
              '- Hourly: $' + (b.hourly_spend||0).toFixed(4) + ' / ' + fmt(b.hourly_limit) + '\n' +
              '- Daily: $' + (b.daily_spend||0).toFixed(4) + ' / ' + fmt(b.daily_limit) + '\n' +
              '- Monthly: $' + (b.monthly_spend||0).toFixed(4) + ' / ' + fmt(b.monthly_limit), meta: '', tools: [] });
            self.scrollToBottom();
          }).catch(function() {});
          break;
        case '/peers':
          OpenFangAPI.get('/api/network/status').then(function(ns) {
            self.messages.push({ id: ++msgId, role: 'system', text: '**OFP Network**\n' +
              '- Status: ' + (ns.enabled ? 'Enabled' : 'Disabled') + '\n' +
              '- Connected peers: ' + (ns.connected_peers||0) + ' / ' + (ns.total_peers||0), meta: '', tools: [] });
            self.scrollToBottom();
          }).catch(function() {});
          break;
        case '/a2a':
          OpenFangAPI.get('/api/a2a/agents').then(function(res) {
            var agents = res.agents || [];
            if (!agents.length) {
              self.messages.push({ id: ++msgId, role: 'system', text: 'No external A2A agents discovered.', meta: '', tools: [] });
            } else {
              var lines = agents.map(function(a) { return '- **' + a.name + '** — ' + a.url; });
              self.messages.push({ id: ++msgId, role: 'system', text: '**A2A Agents (' + agents.length + ')**\n' + lines.join('\n'), meta: '', tools: [] });
            }
            self.scrollToBottom();
          }).catch(function() {});
          break;
      }
    },

    async autoLoadAgent() {
      // WebUI always uses a dedicated 'webui' session to avoid conflict with Telegram/other channels
      // Fetch actual model from gateway config (source of truth)
      var webuiAgent = { id: 'webui', name: 'WebUI Chat', state: 'Idle', status: 'idle', model: '', model_provider: '', model_name: '', provider: '', identity: {} };
      this.selectAgent(webuiAgent);
      // Async update header with real model from gateway
      var self = this;
      OpenFangAPI.getStatus().then(function(s) {
        var model = s.default_model || '';
        if (self.currentAgent && self.currentAgent.id === 'webui') {
          self.currentAgent.model = model;
          self.currentAgent.model_provider = '';
          self.currentAgent.model_name = parseModelName(model);
        }
      }).catch(function() {});
    },

    selectAgent(agent) {
      this.currentAgent = agent;
      // Only clear messages when switching to a different agent.
      // When returning to the same agent after tab navigation, currentAgent was null
      // (x-if unmounted the component) but the store still has the correct agentId.
      if (Alpine.store('app').chatAgentId !== agent.id) {
        this.messages = [];
        Alpine.store('app').chatAgentId = agent.id;
      }
      this.connectWs(agent.id);
      // Show welcome tips on first use
      if (!localStorage.getItem('of-chat-tips-seen')) {
        var localMsgId = 0;
        this.messages.push({
          id: ++localMsgId,
          role: 'system',
          text: '**Welcome to OpenClaw Chat!**\n\n' +
            '- Type `/` to see available commands\n' +
            '- `/help` shows all commands\n' +
            '- `/think on` enables extended reasoning\n' +
            '- `/context` shows context window usage\n' +
            '- `/verbose off` hides tool details\n' +
            '- `Ctrl+Shift+F` toggles focus mode\n' +
            '- Drag & drop files to attach them\n' +
            '- `Ctrl+/` opens the command palette',
          meta: '',
          tools: []
        });
        localStorage.setItem('of-chat-tips-seen', 'true');
      }
      // Focus input after agent selection
      var self = this;
      this.$nextTick(function() {
        var el = document.getElementById('msg-input');
        if (el) el.focus();
      });
    },

    async loadSession(agentId) {
      var self = this;
      // Guard: avoid overwriting messages already populated by loadChatHistory (race on refresh)
      if (self.messages.length) return;
      try {
        var data = await OpenFangAPI.get('/api/agents/' + agentId + '/session');
        if (data.messages && data.messages.length) {
          var parsed = [];
          data.messages.forEach(function(m) {
            var roleStr = (m.role || '').toLowerCase();
            var role = roleStr === 'user' ? 'user' : (roleStr === 'system' ? 'system' : 'agent');
            var content = m.content;

            // content is array of blocks: [{type:"text",...},{type:"thinking",...},{type:"toolCall",...},{type:"toolResult",...}]
            if (Array.isArray(content)) {
              var textParts = [];
              var tools = [];
              var toolResultMap = {}; // toolUseId -> result

              // First pass: collect toolResults
              content.forEach(function(b) {
                if (b.type === 'toolResult' && b.toolUseId) {
                  var res = '';
                  if (typeof b.content === 'string') res = b.content;
                  else if (Array.isArray(b.content)) res = b.content.filter(function(x) { return x.type === 'text'; }).map(function(x) { return x.text; }).join('\n');
                  toolResultMap[b.toolUseId] = { result: res, is_error: !!b.isError };
                }
              });

              // Second pass: build text + tool cards
              content.forEach(function(b, idx) {
                if (b.type === 'text' && b.text) {
                  textParts.push(b.text);
                } else if (b.type === 'toolCall' || b.type === 'tool_use') {
                  var toolId = b.id || b.toolUseId || ('tool-hist-' + idx);
                  var toolResult = toolResultMap[toolId] || {};
                  var inputStr = '';
                  try { inputStr = typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments || b.input || '', null, 2); } catch(e) {}
                  tools.push({
                    id: toolId + '-hist',
                    name: b.name || b.toolName || 'tool',
                    running: false,
                    expanded: false,
                    input: inputStr,
                    result: toolResult.result || '',
                    is_error: !!toolResult.is_error
                  });
                }
                // skip thinking blocks — don't show in history
              });

              var text = self.sanitizeToolText(role === 'user' ? stripEnvelopePrefix(textParts.join('\n')) : textParts.join('\n'));
              parsed.push({ id: ++msgId, role: role, text: text, meta: '', tools: tools, _thinking: '', _thinkOpen: false });
            } else {
              // Plain string content
              var rawText2 = extractContentText(content);
              var text2 = self.sanitizeToolText(role === 'user' ? stripEnvelopePrefix(rawText2) : rawText2);
              var tools2 = (m.tools || []).map(function(t, idx2) {
                return { id: (t.name || 'tool') + '-hist-' + idx2, name: t.name || 'unknown', running: false, expanded: false, input: t.input || '', result: t.result || '', is_error: !!t.is_error };
              });
              parsed.push({ id: ++msgId, role: role, text: text2, meta: '', tools: tools2, _thinking: '', _thinkOpen: false });
            }
          });
          self.messages = parsed;
          self.$nextTick(function() { self.scrollToBottom(); });
        }
      } catch(e) { /* silent */ }
    },

    // Multi-session: load session list for current agent
    async loadSessions(agentId) {
      try {
        var data = await OpenFangAPI.get('/api/agents/' + agentId + '/sessions');
        this.sessions = data.sessions || [];
      } catch(e) { this.sessions = []; }
    },

    // Multi-session: create a new session
    async createSession() {
      if (!this.currentAgent) return;
      var label = prompt('Session name (optional):');
      if (label === null) return; // cancelled
      try {
        await OpenFangAPI.post('/api/agents/' + this.currentAgent.id + '/sessions', {
          label: label.trim() || undefined
        });
        await this.loadSessions(this.currentAgent.id);
        this.messages = [];
        await this.loadSession(this.currentAgent.id);
        this.scrollToBottom();
        if (typeof OpenFangToast !== 'undefined') OpenFangToast.success('New session created');
      } catch(e) {
        if (typeof OpenFangToast !== 'undefined') OpenFangToast.error('Failed to create session');
      }
    },

    // Multi-session: switch to an existing session
    async switchSession(sessionId) {
      if (!this.currentAgent) return;
      try {
        await OpenFangAPI.post('/api/agents/' + this.currentAgent.id + '/sessions/' + sessionId + '/switch', {});
        this.messages = [];
        await this.loadSession(this.currentAgent.id);
        await this.loadSessions(this.currentAgent.id);
        // Reconnect WebSocket for new session
        this._wsAgent = null;
        this.connectWs(this.currentAgent.id);
      } catch(e) {
        if (typeof OpenFangToast !== 'undefined') OpenFangToast.error('Failed to switch session');
      }
    },

    connectWs(agentId) {
      // _wsAgent is local state — lost on component remount (x-if).
      // Also skip if the WS is already connected to this agent.
      if (this._wsAgent === agentId && OpenFangAPI.isWsConnected()) return;
      this._wsAgent = agentId;
      var self = this;

      OpenFangAPI.wsConnect(agentId, {
        onOpen: function() {
          Alpine.store('app').wsConnected = true;
          // Always reload history on (re)connect to pick up any server-side changes
          // (e.g. model switch created a new session, browser refresh cleared store).
          // loadChatHistory will only replace messages if server returns non-empty data.
          self.loadChatHistory(agentId);
        },
        onMessage: function(data) { self.handleWsMessage(data); },
        onClose: function() {
          Alpine.store('app').wsConnected = false;
          self._wsAgent = null;
        },
        onError: function() {
          Alpine.store('app').wsConnected = false;
          self._wsAgent = null;
        }
      });
    },

    loadChatHistory(agentId) {
      var self = this;
      OpenFangAPI.request('chat.history', { sessionKey: agentId, limit: 100 }).then(function(res) {
        var msgs = (res && res.messages) || [];
        if (!msgs.length) return;
        // Skip if agent is currently streaming — don't overwrite live messages
        if (self.sending) return;
        var historyMessages = [];
        msgs.forEach(function(m) {
          // Only render user and assistant turns — skip toolResult, thinking-only, etc.
          var msgRole = m.role;
          if (msgRole !== 'user' && msgRole !== 'assistant') return;
          var role = msgRole === 'user' ? 'user' : 'agent';
          var rawText = '';
          if (typeof m.content === 'string') {
            rawText = m.content;
          } else if (Array.isArray(m.content)) {
            rawText = m.content
              .filter(function(b) { return b.type === 'text'; })
              .map(function(b) { return b.text || ''; })
              .join('');
          }
          var parsed = extractThinking(rawText);
          // Skip messages with no visible text (thinking-only intermediate turns)
          if (!parsed.text.trim()) return;
          var entry = { id: ++msgId, role: role, text: parsed.text, meta: '', tools: [], _thinking: parsed.thinking || '', _thinkOpen: false };
          historyMessages.push(entry);
        });
        if (historyMessages.length) {
          // Don't replace if the user just sent a message (within 10s) — avoids
          // the history response overwriting a newly-pushed user message bubble.
          var hasRecentUserMsg = self.messages.some(function(m) {
            return m.role === 'user' && m.ts && (Date.now() - m.ts) < 10000;
          });
          if (!hasRecentUserMsg) {
            self.messages = historyMessages;
            self.$nextTick(function() { self.scrollToBottom(); });
          }
        }
      }).catch(function() { /* non-critical — history just won't show */ });
    },

    handleWsMessage(data) {
      switch (data.type) {
        case 'connected': break;

        // Legacy thinking event (backward compat)
        case 'thinking':
          if (!this.messages.length || !this.messages[this.messages.length - 1].thinking) {
            var thinkLabel = data.level ? 'Thinking (' + data.level + ')...' : 'Processing...';
            this.messages.push({ id: ++msgId, role: 'agent', text: thinkLabel, meta: '', thinking: true, streaming: true, tools: [], _thinking: '', _thinkOpen: false });
            this.scrollToBottom();
            this._resetTypingTimeout();
          } else if (data.level) {
            var lastThink = this.messages[this.messages.length - 1];
            if (lastThink && lastThink.thinking) lastThink.text = 'Thinking (' + data.level + ')...';
          }
          break;

        // New typing lifecycle
        case 'typing':
          if (data.state === 'start') {
            if (!this.messages.length || !this.messages[this.messages.length - 1].thinking) {
              this.messages.push({ id: ++msgId, role: 'agent', text: 'Processing...', meta: '', thinking: true, streaming: true, tools: [], _thinking: '', _thinkOpen: false });
              this.scrollToBottom();
            }
            this._resetTypingTimeout();
          } else if (data.state === 'tool') {
            var typingMsg = this.messages.length ? this.messages[this.messages.length - 1] : null;
            if (typingMsg && (typingMsg.thinking || typingMsg.streaming)) {
              typingMsg.text = 'Using ' + (data.tool || 'tool') + '...';
            }
            this._resetTypingTimeout();
          } else if (data.state === 'stop') {
            this._clearTypingTimeout();
          }
          break;

        case 'phase':
          // Show tool/phase progress so the user sees the agent is working
          var phaseMsg = this.messages.length ? this.messages[this.messages.length - 1] : null;
          if (phaseMsg && (phaseMsg.thinking || phaseMsg.streaming)) {
            var detail = data.detail || data.phase || 'Working...';
            // Context warning: show prominently
            if (data.phase === 'context_warning') {
              this.messages.push({ id: ++msgId, role: 'system', text: detail, meta: '', tools: [] });
            } else if (data.phase === 'thinking' && this.thinkingMode === 'stream') {
              // Stream reasoning tokens to a collapsible panel
              if (!phaseMsg._reasoning) phaseMsg._reasoning = '';
              phaseMsg._reasoning += (detail || '') + '\n';
              phaseMsg.text = '<details><summary>Reasoning...</summary>\n\n' + phaseMsg._reasoning + '</details>';
            } else {
              phaseMsg.text = detail;
            }
          }
          this.scrollToBottom();
          break;

        case 'text_replace':
        case 'text_delta':
          var last = this.messages.length ? this.messages[this.messages.length - 1] : null;
          if (last && last.streaming) {
            if (last.thinking) { last.text = ''; last.thinking = false; }
            // If we already detected a text-based tool call, skip further text
            if (last._toolTextDetected) break;
            var newContent = extractContentText(data.content);
            // text_replace: SET full cumulative text each time (gateway idempotent)
            // text_delta: APPEND incremental chunk
            var rawFull;
            if (data.type === 'text_replace') {
              rawFull = newContent;
            } else {
              rawFull = (last._rawText || '') + newContent;
            }
            last._rawText = rawFull;
            var parsed = extractThinking(rawFull);
            if (parsed.thinking) last._thinking = parsed.thinking;
            last.text = parsed.text;
            // Detect function-call patterns streamed as text and convert to tool cards
            var fcIdx = last.text.search(/\w+<\/function[=,>]/);
            if (fcIdx === -1) fcIdx = last.text.search(/<function=\w+>/);
            if (fcIdx !== -1) {
              var fcPart = last.text.substring(fcIdx);
              var toolMatch = fcPart.match(/^(\w+)<\/function/) || fcPart.match(/^<function=(\w+)>/);
              last.text = last.text.substring(0, fcIdx).trim();
              last._toolTextDetected = true;
              if (toolMatch) {
                if (!last.tools) last.tools = [];
                var inputMatch = fcPart.match(/[=,>]\s*(\{[\s\S]*)/);
                last.tools.push({
                  id: toolMatch[1] + '-txt-' + Date.now(),
                  name: toolMatch[1],
                  running: true,
                  expanded: false,
                  input: inputMatch ? inputMatch[1].replace(/<\/function>?\s*$/, '').trim() : '',
                  result: '',
                  is_error: false
                });
              }
            }
            this.tokenCount = Math.round(last.text.length / 4);
          } else {
            this.messages.push({ id: ++msgId, role: 'agent', text: extractContentText(data.content), meta: '', streaming: true, tools: [], _thinking: '', _thinkOpen: false });
          }
          this.scrollToBottom();
          break;

        case 'tool_start':
          var lastMsg = this.messages.length ? this.messages[this.messages.length - 1] : null;
          // Create a streaming agent message if there isn't one yet (tool called before any text)
          if (!lastMsg || !lastMsg.streaming || lastMsg.role !== 'agent') {
            this.messages.push({ id: ++msgId, role: 'agent', text: '', meta: '', streaming: true, tools: [], _thinking: '', _thinkOpen: false });
            lastMsg = this.messages[this.messages.length - 1];
          }
          if (!lastMsg.tools) lastMsg.tools = [];
          lastMsg.tools.push({ id: data.toolCallId || (data.tool + '-' + Date.now()), name: data.tool, running: true, expanded: false, input: '', result: '', is_error: false });
          this.scrollToBottom();
          break;

        case 'tool_end':
          // Tool call parsed by LLM — update tool card with input params
          var lastMsg2 = this.messages.length ? this.messages[this.messages.length - 1] : null;
          if (lastMsg2 && lastMsg2.tools) {
            for (var ti = lastMsg2.tools.length - 1; ti >= 0; ti--) {
              if (lastMsg2.tools[ti].name === data.tool && lastMsg2.tools[ti].running) {
                lastMsg2.tools[ti].input = data.input || '';
                break;
              }
            }
          }
          break;

        case 'tool_result':
          // Tool execution completed — update tool card with result
          var lastMsg3 = this.messages.length ? this.messages[this.messages.length - 1] : null;
          if (lastMsg3 && lastMsg3.tools) {
            for (var ri = lastMsg3.tools.length - 1; ri >= 0; ri--) {
              var toolCardId = data.toolCallId || null;
              var nameMatch = lastMsg3.tools[ri].name === data.tool;
              var idMatch = toolCardId && lastMsg3.tools[ri].id === toolCardId;
              if ((idMatch || (!toolCardId && nameMatch)) && lastMsg3.tools[ri].running) {
                lastMsg3.tools[ri].running = false;
                lastMsg3.tools[ri].result = data.result || '';
                lastMsg3.tools[ri].is_error = !!data.is_error;
                // Extract image URLs from image_generate or browser_screenshot results
                if ((data.tool === 'image_generate' || data.tool === 'browser_screenshot') && !data.is_error) {
                  try {
                    var parsed = JSON.parse(data.result);
                    if (parsed.image_urls && parsed.image_urls.length) {
                      lastMsg3.tools[ri]._imageUrls = parsed.image_urls;
                    }
                  } catch(e) { /* not JSON */ }
                }
                // Extract audio file path from text_to_speech results
                if (data.tool === 'text_to_speech' && !data.is_error) {
                  try {
                    var ttsResult = JSON.parse(data.result);
                    if (ttsResult.saved_to) {
                      lastMsg3.tools[ri]._audioFile = ttsResult.saved_to;
                      lastMsg3.tools[ri]._audioDuration = ttsResult.duration_estimate_ms;
                    }
                  } catch(e) { /* not JSON */ }
                }
                break;
              }
            }
          }
          this.scrollToBottom();
          break;

        case 'response':
          this._clearTypingTimeout();
          // Update context pressure from response
          if (data.context_pressure) {
            this.contextPressure = data.context_pressure;
          }
          // Collect streamed text + thinking before removing streaming messages.
          // Also check _rawText on thinking bubbles in case text_replace arrived
          // while the bubble was still in thinking state (e.g. after tab remount).
          var streamedText = '';
          var streamedThinking = '';
          var streamedTools = [];
          this.messages.forEach(function(m) {
            if (m.streaming && m.role === 'agent') {
              if (!m.thinking) {
                streamedText += m.text || '';
                if (m._thinking) streamedThinking += m._thinking;
                streamedTools = streamedTools.concat(m.tools || []);
              } else if (m._rawText) {
                // thinking bubble that received text_replace but wasn't converted yet
                var p = extractThinking(m._rawText);
                streamedText += p.text || '';
                if (p.thinking) streamedThinking += p.thinking;
              }
            }
          });
          streamedTools.forEach(function(t) {
            t.running = false;
            // Text-detected tool calls (model leaked as text) — mark as not executed
            if (t.id && t.id.indexOf('-txt-') !== -1 && !t.result) {
              t.result = 'Model attempted this call as text (not executed via tool system)';
              t.is_error = true;
            }
          });
          this.messages = this.messages.filter(function(m) { return !m.thinking && !m.streaming; });
          var meta = (data.input_tokens || 0) + ' in / ' + (data.output_tokens || 0) + ' out';
          if (data.cost_usd != null) meta += ' | $' + data.cost_usd.toFixed(4);
          if (data.iterations) meta += ' | ' + data.iterations + ' iter';
          if (data.fallback_model) meta += ' | fallback: ' + data.fallback_model;
          // Use streamedText accumulated via text_delta APPENDs (openfang approach).
          // data.content is empty — gateway sends all text as incremental deltas,
          // so streamedText in the bubble is always the complete correct text.
          var finalText = streamedText || extractContentText(data.content);
          // Strip raw function-call JSON that some models leak as text
          finalText = this.sanitizeToolText(finalText);
          // If text is empty but tools ran, show a summary
          if (!finalText.trim() && streamedTools.length) {
            finalText = '';
          }
          var finalMsg = { id: ++msgId, role: 'agent', text: finalText, meta: meta, tools: streamedTools, ts: Date.now(), _thinking: streamedThinking, _thinkOpen: false };
          this.messages.push(finalMsg);
          this.sending = false;
          this.tokenCount = 0;
          this.scrollToBottom();
          var self3 = this;
          this.$nextTick(function() {
            var el = document.getElementById('msg-input'); if (el) el.focus();
            self3._processQueue();
          });
          break;

        case 'silent_complete':
          // Agent intentionally chose not to reply (NO_REPLY)
          this._clearTypingTimeout();
          this.messages = this.messages.filter(function(m) { return !m.thinking && !m.streaming; });
          this.sending = false;
          this.tokenCount = 0;
          // No message bubble added — the agent was silent
          var selfSilent = this;
          this.$nextTick(function() { selfSilent._processQueue(); });
          break;

        case 'error':
          this._clearTypingTimeout();
          this.messages = this.messages.filter(function(m) { return !m.thinking && !m.streaming; });
          this.messages.push({ id: ++msgId, role: 'system', text: 'Error: ' + (data.message || data.content || 'unknown'), meta: '', tools: [], ts: Date.now() });
          this.sending = false;
          this.tokenCount = 0;
          this.scrollToBottom();
          var self2 = this;
          this.$nextTick(function() {
            var el = document.getElementById('msg-input'); if (el) el.focus();
            self2._processQueue();
          });
          break;

        case 'agents_updated':
          if (data.agents) {
            Alpine.store('app').agents = data.agents;
            Alpine.store('app').agentCount = data.agents.length;
          }
          break;

        case 'command_result':
          // Update context pressure if included in command result
          if (data.context_pressure) {
            this.contextPressure = data.context_pressure;
          }
          this.messages.push({ id: ++msgId, role: 'system', text: data.message || 'Command executed.', meta: '', tools: [] });
          this.scrollToBottom();
          break;

        case 'canvas':
          // Agent presented an interactive canvas — render it in an iframe sandbox
          var canvasHtml = '<div class="canvas-panel" style="border:1px solid var(--border);border-radius:8px;margin:8px 0;overflow:hidden;">';
          canvasHtml += '<div style="padding:6px 12px;background:var(--surface);border-bottom:1px solid var(--border);font-size:0.85em;display:flex;justify-content:space-between;align-items:center;">';
          canvasHtml += '<span>' + (data.title || 'Canvas') + '</span>';
          canvasHtml += '<span style="opacity:0.5;font-size:0.8em;">' + (data.canvas_id || '').substring(0, 8) + '</span></div>';
          canvasHtml += '<iframe sandbox="allow-scripts" srcdoc="' + (data.html || '').replace(/"/g, '&quot;') + '" ';
          canvasHtml += 'style="width:100%;min-height:300px;border:none;background:#fff;" loading="lazy"></iframe></div>';
          this.messages.push({ id: ++msgId, role: 'agent', text: canvasHtml, meta: 'canvas', isHtml: true, tools: [] });
          this.scrollToBottom();
          break;

        case 'pong': break;
      }
    },

    // Format timestamp for display
    formatTime: function(ts) {
      if (!ts) return '';
      var d = new Date(ts);
      var h = d.getHours();
      var m = d.getMinutes();
      var ampm = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      return h + ':' + (m < 10 ? '0' : '') + m + ' ' + ampm;
    },

    // Copy message text to clipboard
    copyMessage: function(msg) {
      var text = msg.text || '';
      navigator.clipboard.writeText(text).then(function() {
        msg._copied = true;
        setTimeout(function() { msg._copied = false; }, 2000);
      }).catch(function() {});
    },

    // Process queued messages after current response completes
    _processQueue: function() {
      if (!this.messageQueue.length || this.sending) return;
      var next = this.messageQueue.shift();
      this._sendPayload(next.text, next.files, next.images);
    },

    async sendMessage() {
      if (!this.currentAgent || (!this.inputText.trim() && !this.attachments.length)) return;
      var text = this.inputText.trim();

      // Handle slash commands
      if (text.startsWith('/') && !this.attachments.length) {
        var cmd = text.split(' ')[0].toLowerCase();
        var cmdArgs = text.substring(cmd.length).trim();
        var matched = this.slashCommands.find(function(c) { return c.cmd === cmd; });
        if (matched) {
          this.executeSlashCommand(matched.cmd, cmdArgs);
          return;
        }
      }

      this.inputText = '';

      // Reset textarea height to single line
      var ta = document.getElementById('msg-input');
      if (ta) ta.style.height = '';

      // Upload attachments first if any
      var fileRefs = [];
      var uploadedFiles = [];
      if (this.attachments.length) {
        for (var i = 0; i < this.attachments.length; i++) {
          var att = this.attachments[i];
          att.uploading = true;
          try {
            var uploadRes = await OpenFangAPI.upload(this.currentAgent.id, att.file);
            fileRefs.push('[File: ' + att.file.name + ']');
            uploadedFiles.push({ file_id: uploadRes.file_id, filename: uploadRes.filename, content_type: uploadRes.content_type });
          } catch(e) {
            OpenFangToast.error('Failed to upload ' + att.file.name);
            fileRefs.push('[File: ' + att.file.name + ' (upload failed)]');
          }
          att.uploading = false;
        }
        // Clean up previews
        for (var j = 0; j < this.attachments.length; j++) {
          if (this.attachments[j].preview) URL.revokeObjectURL(this.attachments[j].preview);
        }
        this.attachments = [];
      }

      // Build final message text
      var finalText = text;
      if (fileRefs.length) {
        finalText = (text ? text + '\n' : '') + fileRefs.join('\n');
      }

      // Collect image references for inline rendering
      var msgImages = uploadedFiles.filter(function(f) { return f.content_type && f.content_type.startsWith('image/'); });

      // Always show user message immediately
      this.messages.push({ id: ++msgId, role: 'user', text: finalText, meta: '', tools: [], images: msgImages, ts: Date.now() });
      this.scrollToBottom();
      localStorage.setItem('of-first-msg', 'true');

      // If already streaming, queue this message
      if (this.sending) {
        this.messageQueue.push({ text: finalText, files: uploadedFiles, images: msgImages });
        return;
      }

      this._sendPayload(finalText, uploadedFiles, msgImages);
    },

    async _sendPayload(finalText, uploadedFiles, msgImages) {
      this.sending = true;
      var self = this;
      var sessionKey = this.currentAgent ? this.currentAgent.id : 'main';

      // Show thinking indicator
      this.messages.push({ id: ++msgId, role: 'agent', text: '', meta: '', thinking: true, streaming: true, tools: [], ts: Date.now(), _thinking: '', _thinkOpen: false });
      this.scrollToBottom();

      // Use chat.send RPC for streaming (gateway emits 'chat' events back to all clients)
      if (OpenFangAPI.isWsConnected()) {
        try {
          var idemKey = 'ui-' + Date.now() + '-' + Math.random().toString(36).slice(2);
          // Register runId so event router can filter duplicates (like openclaw-old)
          if (OpenFangAPI.setChatRunId) OpenFangAPI.setChatRunId(sessionKey, idemKey);
          var chatParams = {
            sessionKey: sessionKey,
            message: finalText,
            idempotencyKey: idemKey,
            thinking: this.thinkingMode !== 'off' ? this.thinkingMode : undefined,
            timeoutMs: 600000
          };
          if (uploadedFiles && uploadedFiles.length) chatParams.attachments = uploadedFiles;
          // chat.send blocks until agent run completes; 'chat' events stream in the meantime
          await OpenFangAPI.request('chat.send', chatParams, 600000);
          // By the time chat.send resolves, the 'final' chat event has already handled the response
        } catch(e) {
          // Only show error if not already handled by chat event (sending may already be false)
          if (self.sending) {
            self.messages = self.messages.filter(function(m) { return !m.thinking && !m.streaming; });
            self.messages.push({ id: ++msgId, role: 'system', text: 'Error: ' + (e.message || 'Send failed'), meta: '', tools: [], ts: Date.now() });
            self.sending = false;
            self.scrollToBottom();
            self.$nextTick(function() {
              var el = document.getElementById('msg-input'); if (el) el.focus();
              self._processQueue();
            });
          }
        }
        return;
      }

      // HTTP fallback (no streaming)
      OpenFangToast.info('Using HTTP mode (no streaming)');
      try {
        var httpBody = { message: finalText };
        if (uploadedFiles && uploadedFiles.length) httpBody.attachments = uploadedFiles;
        var res = await OpenFangAPI.post('/api/agents/' + sessionKey + '/message', httpBody);
        this.messages = this.messages.filter(function(m) { return !m.thinking && !m.streaming; });
        var httpMeta = (res.input_tokens || 0) + ' in / ' + (res.output_tokens || 0) + ' out';
        if (res.cost_usd != null) httpMeta += ' | $' + res.cost_usd.toFixed(4);
        if (res.iterations) httpMeta += ' | ' + res.iterations + ' iter';
        this.messages.push({ id: ++msgId, role: 'agent', text: res.response || '', meta: httpMeta, tools: [], ts: Date.now() });
      } catch(e) {
        this.messages = this.messages.filter(function(m) { return !m.thinking && !m.streaming; });
        this.messages.push({ id: ++msgId, role: 'system', text: 'Error: ' + e.message, meta: '', tools: [], ts: Date.now() });
      }
      this.sending = false;
      this.scrollToBottom();
      this.$nextTick(function() {
        var el = document.getElementById('msg-input'); if (el) el.focus();
        self._processQueue();
      });
    },

    // Stop the current agent run
    stopAgent: function() {
      if (!this.currentAgent) return;
      var self = this;
      OpenFangAPI.post('/api/agents/' + this.currentAgent.id + '/stop', {}).then(function(res) {
        self.messages.push({ id: ++msgId, role: 'system', text: res.message || 'Run cancelled', meta: '', tools: [], ts: Date.now() });
        self.sending = false;
        self.scrollToBottom();
        self.$nextTick(function() { self._processQueue(); });
      }).catch(function(e) { OpenFangToast.error('Stop failed: ' + e.message); });
    },

    killAgent() {
      if (!this.currentAgent) return;
      var self = this;
      var name = this.currentAgent.name;
      OpenFangToast.confirm('Stop Agent', 'Stop agent "' + name + '"? The agent will be shut down.', async function() {
        try {
          await OpenFangAPI.del('/api/agents/' + self.currentAgent.id);
          OpenFangAPI.wsDisconnect();
          self._wsAgent = null;
          self.currentAgent = null;
          self.messages = [];
          OpenFangToast.success('Agent "' + name + '" stopped');
          Alpine.store('app').refreshAgents();
        } catch(e) {
          OpenFangToast.error('Failed to stop agent: ' + e.message);
        }
      });
    },

    scrollToBottom() {
      var self = this;
      var el = document.getElementById('messages');
      if (el) self.$nextTick(function() { el.scrollTop = el.scrollHeight; });
    },

    addFiles(files) {
      var self = this;
      var allowed = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain', 'application/pdf',
                      'text/markdown', 'application/json', 'text/csv'];
      var allowedExts = ['.txt', '.pdf', '.md', '.json', '.csv'];
      for (var i = 0; i < files.length; i++) {
        var file = files[i];
        if (file.size > 10 * 1024 * 1024) {
          OpenFangToast.warn('File "' + file.name + '" exceeds 10MB limit');
          continue;
        }
        var typeOk = allowed.indexOf(file.type) !== -1;
        if (!typeOk) {
          var ext = file.name.lastIndexOf('.') !== -1 ? file.name.substring(file.name.lastIndexOf('.')).toLowerCase() : '';
          typeOk = allowedExts.indexOf(ext) !== -1 || file.type.startsWith('image/');
        }
        if (!typeOk) {
          OpenFangToast.warn('File type not supported: ' + file.name);
          continue;
        }
        var preview = null;
        if (file.type.startsWith('image/')) {
          preview = URL.createObjectURL(file);
        }
        self.attachments.push({ file: file, preview: preview, uploading: false });
      }
    },

    removeAttachment(idx) {
      var att = this.attachments[idx];
      if (att && att.preview) URL.revokeObjectURL(att.preview);
      this.attachments.splice(idx, 1);
    },

    handleDrop(e) {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        this.addFiles(e.dataTransfer.files);
      }
    },

    isGrouped(idx) {
      if (idx === 0) return false;
      var prev = this.messages[idx - 1];
      var curr = this.messages[idx];
      return prev && curr && prev.role === curr.role && !curr.thinking && !prev.thinking;
    },

    // Strip raw function-call text that some models (Llama, Groq, etc.) leak into output.
    // These models don't use proper tool_use blocks — they output function calls as plain text.
    sanitizeToolText: function(text) {
      if (!text) return text;
      // Pattern: tool_name</function={"key":"value"} or tool_name</function,{...}
      text = text.replace(/\s*\w+<\/function[=,]?\s*\{[\s\S]*$/gm, '');
      // Pattern: <function=tool_name>{...}</function>
      text = text.replace(/<function=\w+>[\s\S]*?<\/function>/g, '');
      // Pattern: tool_name{"type":"function",...}
      text = text.replace(/\s*\w+\{"type"\s*:\s*"function"[\s\S]*$/gm, '');
      // Pattern: lone </function...> tags
      text = text.replace(/<\/function[^>]*>/g, '');
      // Pattern: <|python_tag|> or similar special tokens
      text = text.replace(/<\|[\w_]+\|>/g, '');
      return text.trim();
    },

    formatToolJson: function(text) {
      if (!text) return '';
      try { return JSON.stringify(JSON.parse(text), null, 2); }
      catch(e) { return text; }
    },

    // Voice: start recording
    startRecording: async function() {
      if (this.recording) return;
      try {
        var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        var mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' :
                       MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';
        this._audioChunks = [];
        this._mediaRecorder = new MediaRecorder(stream, { mimeType: mimeType });
        var self = this;
        this._mediaRecorder.ondataavailable = function(e) {
          if (e.data.size > 0) self._audioChunks.push(e.data);
        };
        this._mediaRecorder.onstop = function() {
          stream.getTracks().forEach(function(t) { t.stop(); });
          self._handleRecordingComplete();
        };
        this._mediaRecorder.start(250);
        this.recording = true;
        this.recordingTime = 0;
        this._recordingTimer = setInterval(function() { self.recordingTime++; }, 1000);
      } catch(e) {
        if (typeof OpenFangToast !== 'undefined') OpenFangToast.error('Microphone access denied');
      }
    },

    // Voice: stop recording
    stopRecording: function() {
      if (!this.recording || !this._mediaRecorder) return;
      this._mediaRecorder.stop();
      this.recording = false;
      if (this._recordingTimer) { clearInterval(this._recordingTimer); this._recordingTimer = null; }
    },

    // Voice: handle completed recording — upload and transcribe
    _handleRecordingComplete: async function() {
      if (!this._audioChunks.length || !this.currentAgent) return;
      var blob = new Blob(this._audioChunks, { type: this._audioChunks[0].type || 'audio/webm' });
      this._audioChunks = [];
      if (blob.size < 100) return; // too small

      // Show a temporary "Transcribing..." message
      this.messages.push({ id: ++msgId, role: 'system', text: 'Transcribing audio...', thinking: true, ts: Date.now(), tools: [] });
      this.scrollToBottom();

      try {
        // Upload audio file
        var ext = blob.type.includes('webm') ? 'webm' : blob.type.includes('ogg') ? 'ogg' : 'mp3';
        var file = new File([blob], 'voice_' + Date.now() + '.' + ext, { type: blob.type });
        var upload = await OpenFangAPI.upload(this.currentAgent.id, file);

        // Remove the "Transcribing..." message
        this.messages = this.messages.filter(function(m) { return !m.thinking || m.role !== 'system'; });

        // Use server-side transcription if available, otherwise fall back to placeholder
        var text = (upload.transcription && upload.transcription.trim())
          ? upload.transcription.trim()
          : '[Voice message - audio: ' + upload.filename + ']';
        this._sendPayload(text, [upload], []);
      } catch(e) {
        this.messages = this.messages.filter(function(m) { return !m.thinking || m.role !== 'system'; });
        if (typeof OpenFangToast !== 'undefined') OpenFangToast.error('Failed to upload audio: ' + (e.message || 'unknown error'));
      }
    },

    // Voice: format recording time as MM:SS
    formatRecordingTime: function() {
      var m = Math.floor(this.recordingTime / 60);
      var s = this.recordingTime % 60;
      return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    },

    // Search: toggle open/close
    toggleSearch: function() {
      this.searchOpen = !this.searchOpen;
      if (this.searchOpen) {
        var self = this;
        this.$nextTick(function() {
          var el = document.getElementById('chat-search-input');
          if (el) el.focus();
        });
      } else {
        this.searchQuery = '';
      }
    },

    // Search: filter messages by query
    get filteredMessages() {
      if (!this.searchQuery.trim()) return this.messages;
      var q = this.searchQuery.toLowerCase();
      return this.messages.filter(function(m) {
        return (m.text && m.text.toLowerCase().indexOf(q) !== -1) ||
               (m.tools && m.tools.some(function(t) { return t.name.toLowerCase().indexOf(q) !== -1; }));
      });
    },

    // Search: highlight matched text in a string
    highlightSearch: function(html) {
      if (!this.searchQuery.trim() || !html) return html;
      var q = this.searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      var regex = new RegExp('(' + q + ')', 'gi');
      return html.replace(regex, '<mark style="background:var(--warning);color:var(--bg);border-radius:2px;padding:0 2px">$1</mark>');
    },

    renderMarkdown: renderMarkdown,
    escapeHtml: escapeHtml
  };
}

// Strip agent envelope prefix from Telegram/surface messages before display.
// Format: "[Surface Sender id:NNNNN TIMESTAMP] actual message\n[message_id: N]"
function stripEnvelopePrefix(text) {
  if (!text || typeof text !== 'string') return text;
  // Strip leading [...] header (envelope)
  var stripped = text.replace(/^\[[^\]]*\]\s*/, '');
  // Strip trailing [message_id: N] suffix (may be on its own line)
  stripped = stripped.replace(/\n?\[message_id:\s*\d+\]\s*$/, '');
  return stripped.trim() || text;
}

// Extract plain text from openclaw content block format:
// content can be: string | [{type:"text",text:"..."},...] | [{type:"thinking",...},{type:"text",...}]
function extractContentText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(function(b) { return b && b.type === 'text' && typeof b.text === 'string'; })
      .map(function(b) { return b.text; })
      .join('\n');
  }
  return String(content);
}
