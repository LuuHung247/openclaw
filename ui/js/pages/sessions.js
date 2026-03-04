// OpenFang Sessions Page — Session listing + Memory tab
'use strict';

function sessionsPage() {
  return {
    tab: 'sessions',
    // -- Sessions state --
    sessions: [],
    searchFilter: '',
    loading: true,
    loadError: '',

    // -- Memory state --
    memAgentId: '',
    kvPairs: [],
    showAdd: false,
    newKey: '',
    newValue: '""',
    editingKey: null,
    editingValue: '',
    memLoading: false,
    memLoadError: '',

    // -- Sessions methods --
    async loadSessions() {
      this.loading = true;
      this.loadError = '';
      try {
        var data = await OpenFangAPI.get('/api/sessions');
        var sessions = data.sessions || [];
        // session_key is the primary ID in openclaw; map agent_id → session_key for compatibility
        sessions = sessions.map(function(s) {
          if (!s.session_id) s.session_id = s.session_key || s.agent_id;
          if (!s.agent_id) s.agent_id = s.session_key;
          var key = s.session_key || s.agent_id || '';
          // Display name mapping
          if (key === 'telegram' || key === 'main') {
            s.agent_name = 'Telegram';
          } else if (key === 'webui') {
            s.agent_name = 'WebUI Chat';
          } else {
            s.agent_name = s.agent_id || s.session_key || '';
          }
          return s;
        });
        this.sessions = sessions;
      } catch(e) {
        this.sessions = [];
        this.loadError = e.message || 'Could not load sessions.';
      }
      this.loading = false;
    },

    async loadData() { return this.loadSessions(); },

    get filteredSessions() {
      var f = this.searchFilter.toLowerCase();
      if (!f) return this.sessions;
      return this.sessions.filter(function(s) {
        return (s.agent_name || '').toLowerCase().indexOf(f) !== -1 ||
               (s.agent_id || '').toLowerCase().indexOf(f) !== -1;
      });
    },

    openInChat(session) {
      var sessionKey = session.session_key || session.agent_id || session.session_id;
      var agents = Alpine.store('app').agents;
      var agent = agents.find(function(a) { return a.id === sessionKey; });
      if (agent) {
        Alpine.store('app').pendingAgent = agent;
      } else if (sessionKey) {
        // Create a minimal agent object so chat page can open it
        Alpine.store('app').pendingAgent = { id: sessionKey, name: session.agent_name || sessionKey };
      }
      location.hash = 'agents';
    },

    deleteSession(session) {
      var self = this;
      var sessionKey = (session && typeof session === 'object')
        ? (session.session_key || session.agent_id || session.session_id || session)
        : session;
      var displayName = (session && session.agent_name) ? session.agent_name : sessionKey;
      if (!window.confirm('Clear history of "' + displayName + '"?\nAll messages will be deleted. The session will restart fresh on next use.')) return;
      // sessions.delete properly archives the transcript (no ghost sessions)
      // The session will be auto-recreated on next chat message
      OpenFangAPI.del('/api/sessions/' + sessionKey).then(function() {
        OpenFangToast.success('History of "' + displayName + '" cleared');
        self.loadSessions();
      }).catch(function(e) {
        OpenFangToast.error('Failed to clear history: ' + (e && e.message || 'unknown error'));
      });
    },

    // -- Memory methods --
    async loadKv() {
      if (!this.memAgentId) { this.kvPairs = []; return; }
      this.memLoading = true;
      this.memLoadError = '';
      try {
        // api.js getMemoryKv uses localStorage-backed in-memory store
        var data = await OpenFangAPI.get('/api/memory/agents/' + encodeURIComponent(this.memAgentId) + '/kv');
        this.kvPairs = data.kv_pairs || [];
      } catch(e) {
        this.kvPairs = [];
        this.memLoadError = e.message || 'Could not load memory data.';
      }
      this.memLoading = false;
    },

    async addKey() {
      if (!this.memAgentId || !this.newKey.trim()) return;
      var value;
      try { value = JSON.parse(this.newValue); } catch(e) { value = this.newValue; }
      try {
        await OpenFangAPI.put('/api/memory/agents/' + this.memAgentId + '/kv/' + encodeURIComponent(this.newKey), { value: value });
        this.showAdd = false;
        OpenFangToast.success('Key "' + this.newKey + '" saved');
        this.newKey = '';
        this.newValue = '""';
        await this.loadKv();
      } catch(e) {
        OpenFangToast.error('Failed to save key: ' + e.message);
      }
    },

    deleteKey(key) {
      var self = this;
      OpenFangToast.confirm('Delete Key', 'Delete key "' + key + '"? This cannot be undone.', async function() {
        try {
          await OpenFangAPI.del('/api/memory/agents/' + self.memAgentId + '/kv/' + encodeURIComponent(key));
          OpenFangToast.success('Key "' + key + '" deleted');
          await self.loadKv();
        } catch(e) {
          OpenFangToast.error('Failed to delete key: ' + e.message);
        }
      });
    },

    startEdit(kv) {
      this.editingKey = kv.key;
      this.editingValue = typeof kv.value === 'object' ? JSON.stringify(kv.value, null, 2) : String(kv.value);
    },

    cancelEdit() {
      this.editingKey = null;
      this.editingValue = '';
    },

    async saveEdit() {
      if (!this.editingKey || !this.memAgentId) return;
      var value;
      try { value = JSON.parse(this.editingValue); } catch(e) { value = this.editingValue; }
      try {
        await OpenFangAPI.put('/api/memory/agents/' + this.memAgentId + '/kv/' + encodeURIComponent(this.editingKey), { value: value });
        OpenFangToast.success('Key "' + this.editingKey + '" updated');
        this.editingKey = null;
        this.editingValue = '';
        await this.loadKv();
      } catch(e) {
        OpenFangToast.error('Failed to save: ' + e.message);
      }
    }
  };
}
