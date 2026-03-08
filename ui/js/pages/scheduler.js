// Openclaw Scheduler Page — Cron job management via Gateway WebSocket API
'use strict';

function schedulerPage() {
  return {
    tab: 'jobs',

    // -- Scheduled Jobs state --
    jobs: [],
    loading: true,
    loadError: '',

    // -- Event Triggers state (not implemented yet in openclaw) --
    triggers: [],
    trigLoading: false,
    trigLoadError: '',

    // -- Run History state --
    history: [],
    historyLoading: false,

    // -- Create Job form --
    showCreateForm: false,
    newJob: {
      name: '',
      schedule: 'cron', // 'cron', 'every', 'at'
      cronExpr: '',
      intervalMinutes: 5,
      atTimestamp: '',
      sessionTarget: 'isolated', // 'main' or 'isolated'
      message: '',
      enabled: true,
      description: ''
    },
    creating: false,

    // -- Run Now state --
    runningJobId: '',

    // -- Cron status --
    schedulerStatus: null,

    // Cron presets
    cronPresets: [
      { label: 'Every minute', cron: '* * * * *' },
      { label: 'Every 5 minutes', cron: '*/5 * * * *' },
      { label: 'Every 15 minutes', cron: '*/15 * * * *' },
      { label: 'Every 30 minutes', cron: '*/30 * * * *' },
      { label: 'Every hour', cron: '0 * * * *' },
      { label: 'Every 6 hours', cron: '0 */6 * * *' },
      { label: 'Daily at midnight', cron: '0 0 * * *' },
      { label: 'Daily at 9am', cron: '0 9 * * *' },
      { label: 'Weekdays at 9am', cron: '0 9 * * 1-5' },
      { label: 'Every Monday 9am', cron: '0 9 * * 1' },
      { label: 'First of month', cron: '0 0 1 * *' }
    ],

    // ── Lifecycle ──

    async loadData() {
      this.loading = true;
      this.loadError = '';
      try {
        await Promise.all([this.loadJobs(), this.loadSchedulerStatus()]);
      } catch(e) {
        this.loadError = e.message || 'Could not load scheduler data.';
      }
      this.loading = false;
    },

    async loadSchedulerStatus() {
      try {
        this.schedulerStatus = await OpenFangAPI.getStatus();
      } catch(e) {
        this.schedulerStatus = null;
      }
    },

    async loadJobs() {
      // Openclaw Gateway: cron.list returns { jobs: [...] }
      // Each job: { id, name, description, enabled, createdAtMs, updatedAtMs, schedule, sessionTarget, wakeMode, payload, isolation, state }
      var raw = await OpenFangAPI.getCronJobs();
      this.jobs = (raw || []).map(function(j) {
        // Parse schedule object to human-readable string
        var cron = '';
        if (j.schedule) {
          if (j.schedule.kind === 'cron') {
            cron = j.schedule.expr || '';
          } else if (j.schedule.kind === 'every') {
            var secs = Math.floor((j.schedule.everyMs || 0) / 1000);
            cron = 'every ' + secs + 's';
          } else if (j.schedule.kind === 'at') {
            var at = j.schedule.atMs ? new Date(j.schedule.atMs).toISOString() : '';
            cron = 'at ' + at;
          }
        }
        // Extract message from payload
        var message = '';
        if (j.payload) {
          if (j.payload.kind === 'systemEvent') {
            message = j.payload.text || '';
          } else if (j.payload.kind === 'agentTurn') {
            message = j.payload.message || '';
          }
        }
        // Parse state for timestamps
        var lastRun = j.state && j.state.lastRunAtMs ? new Date(j.state.lastRunAtMs).toISOString() : null;
        var nextRun = j.state && j.state.nextRunAtMs ? new Date(j.state.nextRunAtMs).toISOString() : null;
        var lastStatus = j.state ? j.state.lastStatus : null;
        var lastError = j.state ? j.state.lastError : null;

        return {
          id: j.id,
          name: j.name,
          description: j.description || '',
          cron: cron,
          schedule: j.schedule,
          sessionTarget: j.sessionTarget || 'main',
          message: message,
          enabled: j.enabled !== false,
          last_run: lastRun,
          next_run: nextRun,
          lastStatus: lastStatus,
          lastError: lastError,
          created_at: j.createdAtMs ? new Date(j.createdAtMs).toISOString() : null,
          updated_at: j.updatedAtMs ? new Date(j.updatedAtMs).toISOString() : null
        };
      });
    },

    async loadTriggers() {
      this.trigLoading = true;
      this.trigLoadError = '';
      try {
        var data = await OpenFangAPI.get('/api/triggers');
        this.triggers = Array.isArray(data) ? data : [];
      } catch(e) {
        this.triggers = [];
        this.trigLoadError = e.message || 'Could not load triggers.';
      }
      this.trigLoading = false;
    },

    async loadHistory() {
      this.historyLoading = true;
      try {
        var historyItems = [];
        var jobs = this.jobs || [];
        for (var i = 0; i < jobs.length; i++) {
          var job = jobs[i];
          if (job.last_run) {
            historyItems.push({
              timestamp: job.last_run,
              name: job.name || '(unnamed)',
              type: 'schedule',
              status: job.lastStatus || 'unknown',
              run_count: 0
            });
          }
        }
        // Triggers not implemented yet in openclaw
        historyItems.sort(function(a, b) {
          return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
        });
        this.history = historyItems;
      } catch(e) {
        this.history = [];
      }
      this.historyLoading = false;
    },

    // ── Job CRUD ──

    async createJob() {
      if (!this.newJob.name.trim()) {
        OpenFangToast.warn('Please enter a job name');
        return;
      }
      this.creating = true;
      try {
        var jobName = this.newJob.name;
        // Build schedule object based on type
        var schedule;
        if (this.newJob.schedule === 'cron') {
          if (!this.newJob.cronExpr.trim()) {
            OpenFangToast.warn('Please enter a cron expression');
            this.creating = false;
            return;
          }
          schedule = { kind: 'cron', expr: this.newJob.cronExpr };
        } else if (this.newJob.schedule === 'every') {
          var everyMs = (this.newJob.intervalMinutes || 5) * 60 * 1000;
          schedule = { kind: 'every', everyMs: everyMs };
        } else if (this.newJob.schedule === 'at') {
          if (!this.newJob.atTimestamp) {
            OpenFangToast.warn('Please enter a timestamp');
            this.creating = false;
            return;
          }
          var atMs = new Date(this.newJob.atTimestamp).getTime();
          if (isNaN(atMs)) {
            OpenFangToast.warn('Invalid timestamp');
            this.creating = false;
            return;
          }
          schedule = { kind: 'at', atMs: atMs };
        } else {
          OpenFangToast.warn('Invalid schedule type');
          this.creating = false;
          return;
        }

        // Build payload object
        var payload;
        if (this.newJob.sessionTarget === 'main') {
          payload = {
            kind: 'systemEvent',
            text: this.newJob.message || 'Scheduled task: ' + this.newJob.name
          };
        } else {
          payload = {
            kind: 'agentTurn',
            message: this.newJob.message || 'Scheduled task: ' + this.newJob.name
          };
        }

        // Openclaw Gateway: cron.add accepts full CronJobCreate object
        var jobSpec = {
          name: this.newJob.name,
          description: this.newJob.description || undefined,
          enabled: this.newJob.enabled,
          schedule: schedule,
          sessionTarget: this.newJob.sessionTarget,
          wakeMode: 'next-heartbeat',
          payload: payload,
          isolation: this.newJob.sessionTarget === 'isolated' ? { postToMainPrefix: 'Cron' } : undefined
        };

        await OpenFangAPI.createCronJob(jobSpec);
        this.showCreateForm = false;
        this.newJob = {
          name: '',
          schedule: 'cron',
          cronExpr: '',
          intervalMinutes: 5,
          atTimestamp: '',
          sessionTarget: 'isolated',
          message: '',
          enabled: true,
          description: ''
        };
        OpenFangToast.success('Schedule "' + jobName + '" created');
        await this.loadJobs();
      } catch(e) {
        OpenFangToast.error('Failed to create schedule: ' + (e.message || e));
      }
      this.creating = false;
    },

    async toggleJob(job) {
      try {
        var newState = !job.enabled;
        await OpenFangAPI.patchCronJob(job.id, { enabled: newState });
        job.enabled = newState;
        OpenFangToast.success('Schedule ' + (newState ? 'enabled' : 'paused'));
      } catch(e) {
        OpenFangToast.error('Failed to toggle schedule: ' + (e.message || e));
      }
    },

    deleteJob(job) {
      var self = this;
      var jobName = job.name || job.id;
      OpenFangToast.confirm('Delete Schedule', 'Delete "' + jobName + '"? This cannot be undone.', async function() {
        try {
          await OpenFangAPI.deleteCronJob(job.id);
          self.jobs = self.jobs.filter(function(j) { return j.id !== job.id; });
          OpenFangToast.success('Schedule "' + jobName + '" deleted');
        } catch(e) {
          OpenFangToast.error('Failed to delete schedule: ' + (e.message || e));
        }
      });
    },

    async runNow(job) {
      this.runningJobId = job.id;
      try {
        await OpenFangAPI.runCronJob(job.id);
        OpenFangToast.success('Schedule "' + (job.name || 'job') + '" triggered');
        // Reload to get updated status
        await this.loadJobs();
      } catch(e) {
        OpenFangToast.error('Failed to run job: ' + (e.message || e));
      }
      this.runningJobId = '';
    },

    async viewRuns(job) {
      // Load run history for this job
      try {
        var runs = await OpenFangAPI.getCronRuns(job.id);
        if (runs && runs.length > 0) {
          // Show runs in a simple alert for now (TODO: better UI)
          var lines = runs.map(function(r) {
            return new Date(r.timestamp).toLocaleString() + ' - ' + (r.status || 'unknown');
          }).join('\n');
          alert('Recent runs:\n' + lines);
        } else {
          OpenFangToast.info('No run history yet');
        }
      } catch(e) {
        OpenFangToast.error('Failed to load runs: ' + (e.message || e));
      }
    },

    // ── Trigger helpers (not implemented yet in openclaw) ──

    triggerType(pattern) {
      if (!pattern) return 'unknown';
      if (typeof pattern === 'string') return pattern;
      var keys = Object.keys(pattern);
      if (keys.length === 0) return 'unknown';
      var key = keys[0];
      var names = {
        lifecycle: 'Lifecycle',
        agent_spawned: 'Agent Spawned',
        agent_terminated: 'Agent Terminated',
        system: 'System',
        system_keyword: 'System Keyword',
        memory_update: 'Memory Update',
        memory_key_pattern: 'Memory Key',
        all: 'All Events',
        content_match: 'Content Match'
      };
      return names[key] || key.replace(/_/g, ' ');
    },

    async toggleTrigger(trigger) {
      OpenFangToast.warn('Triggers not implemented yet in openclaw');
      // TODO: Implement in Phase 5
    },

    deleteTrigger(trigger) {
      OpenFangToast.warn('Triggers not implemented yet in openclaw');
      // TODO: Implement in Phase 5
    },

    // ── Utility ──

    get availableAgents() {
      return Alpine.store('app').agents || [];
    },

    agentName(agentId) {
      if (!agentId) return '(any)';
      var agents = this.availableAgents;
      for (var i = 0; i < agents.length; i++) {
        if (agents[i].id === agentId) return agents[i].name;
      }
      if (agentId.length > 12) return agentId.substring(0, 8) + '...';
      return agentId;
    },

    describeCron(expr) {
      if (!expr) return '';
      // Handle non-cron schedule descriptions
      if (expr.indexOf('every ') === 0) return expr;
      if (expr.indexOf('at ') === 0) return 'One-time: ' + expr.substring(3);

      var map = {
        '* * * * *': 'Every minute',
        '*/2 * * * *': 'Every 2 minutes',
        '*/5 * * * *': 'Every 5 minutes',
        '*/10 * * * *': 'Every 10 minutes',
        '*/15 * * * *': 'Every 15 minutes',
        '*/30 * * * *': 'Every 30 minutes',
        '0 * * * *': 'Every hour',
        '0 */2 * * *': 'Every 2 hours',
        '0 */4 * * *': 'Every 4 hours',
        '0 */6 * * *': 'Every 6 hours',
        '0 */12 * * *': 'Every 12 hours',
        '0 0 * * *': 'Daily at midnight',
        '0 6 * * *': 'Daily at 6:00 AM',
        '0 9 * * *': 'Daily at 9:00 AM',
        '0 12 * * *': 'Daily at noon',
        '0 18 * * *': 'Daily at 6:00 PM',
        '0 9 * * 1-5': 'Weekdays at 9:00 AM',
        '0 9 * * 1': 'Mondays at 9:00 AM',
        '0 0 * * 0': 'Sundays at midnight',
        '0 0 1 * *': '1st of every month',
        '0 0 * * 1': 'Mondays at midnight'
      };
      if (map[expr]) return map[expr];

      var parts = expr.split(' ');
      if (parts.length !== 5) return expr;

      var min = parts[0];
      var hour = parts[1];
      var dom = parts[2];
      var mon = parts[3];
      var dow = parts[4];

      if (min.indexOf('*/') === 0 && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
        return 'Every ' + min.substring(2) + ' minutes';
      }
      if (min === '0' && hour.indexOf('*/') === 0 && dom === '*' && mon === '*' && dow === '*') {
        return 'Every ' + hour.substring(2) + ' hours';
      }

      var dowNames = { '0': 'Sun', '1': 'Mon', '2': 'Tue', '3': 'Wed', '4': 'Thu', '5': 'Fri', '6': 'Sat', '7': 'Sun',
                       '1-5': 'Weekdays', '0,6': 'Weekends', '6,0': 'Weekends' };

      if (dom === '*' && mon === '*' && min.match(/^\d+$/) && hour.match(/^\d+$/)) {
        var h = parseInt(hour, 10);
        var m = parseInt(min, 10);
        var ampm = h >= 12 ? 'PM' : 'AM';
        var h12 = h === 0 ? 12 : (h > 12 ? h - 12 : h);
        var mStr = m < 10 ? '0' + m : '' + m;
        var timeStr = h12 + ':' + mStr + ' ' + ampm;
        if (dow === '*') return 'Daily at ' + timeStr;
        var dowLabel = dowNames[dow] || ('DoW ' + dow);
        return dowLabel + ' at ' + timeStr;
      }

      return expr;
    },

    applyCronPreset(preset) {
      this.newJob.cronExpr = preset.cron;
      this.newJob.schedule = 'cron';
    },

    formatTime(ts) {
      if (!ts) return '-';
      try {
        var d = new Date(ts);
        if (isNaN(d.getTime())) return '-';
        return d.toLocaleString();
      } catch(e) { return '-'; }
    },

    relativeTime(ts) {
      if (!ts) return 'never';
      try {
        var diff = Date.now() - new Date(ts).getTime();
        if (isNaN(diff)) return 'never';
        if (diff < 0) {
          // Future time
          var absDiff = Math.abs(diff);
          if (absDiff < 60000) return 'in <1m';
          if (absDiff < 3600000) return 'in ' + Math.floor(absDiff / 60000) + 'm';
          if (absDiff < 86400000) return 'in ' + Math.floor(absDiff / 3600000) + 'h';
          return 'in ' + Math.floor(absDiff / 86400000) + 'd';
        }
        if (diff < 60000) return 'just now';
        if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
        if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
        return Math.floor(diff / 86400000) + 'd ago';
      } catch(e) { return 'never'; }
    },

    jobCount() {
      var enabled = 0;
      for (var i = 0; i < this.jobs.length; i++) {
        if (this.jobs[i].enabled) enabled++;
      }
      return enabled;
    },

    triggerCount() {
      var enabled = 0;
      for (var i = 0; i < this.triggers.length; i++) {
        if (this.triggers[i].enabled) enabled++;
      }
      return enabled;
    }
  };
}
