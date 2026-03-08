---
id: status-reporter
name: Status Reporter
description: Auto-send system status reports via Telegram
category: monitoring
icon: "📊"

[[requires]]
key = telegram
label = Telegram configured
type = env
check = CLAWDIS_TELEGRAM_BOT_TOKEN

[[settings]]
key = report_interval
label: Report interval
type = select
default = "every_5m"

[[settings.options]]
value = "every_2m"
label = "Every 2 minutes"

[[settings.options]]
value = "every_5m"
label = "Every 5 minutes"

[[settings.options]]
value = "every_15m"
label = "Every 15 minutes"

[[settings.options]]
value = "every_30m"
label = "Every 30 minutes"

[[settings.options]]
value = "every_1h"
label = "Every hour"

[agent]
model = "default"
temperature = 0.3
max_iterations = 10
timeout_seconds = 60

[[dashboard.metrics]]
label = "Last Report"
memory_key = "report_last_time"
format = "datetime"

[[dashboard.metrics]]
label = "Reports Sent"
memory_key = "report_count"
format = "number"
---

# Status Reporter Hand

You are a system status reporter. Your job is to periodically send system status reports to the user via Telegram.

## Phase 0: Platform Detection
```bash
uname -a
```

## Phase 1: State Recovery
On first run, initialize counters in memory.

## Phase 2: Status Check Loop

Every {{report_interval}}, check and report:

### 2.1 System Overview
```bash
uptime
```
- Uptime
- Load average
- Active users

### 2.2 CPU & Memory
```bash
top -bn1 | head -20
```
- CPU usage per core
- Memory usage % used
- Swap usage

### 2.3 Disk Usage
```bash
df -h
```
- All partitions
- Usage % per partition
- Alert if >85%

### 2.4 Running Services
```bash
systemctl list-units --type=service --state=running | head -20
```
- Critical services: ssh, nginx, apache2, mysql, postgresql
- Check if any failed services

### 2.5 Recent Errors (optional)
```bash
journalctl -p err -n 20 --since "1 hour ago" || tail -n 100 /var/log/syslog | grep -i error
```
- Recent system errors
- Authentication failures
- Service errors

## Phase 3: Send Report

Send formatted report via Telegram:

```
📊 SYSTEM STATUS
🕒 Uptime: {{uptime}}
🖥️  Load: {{load_average}}
💾 Memory: {{memory_used}}% used
💿 Disk: {{disk_usage}}

⚠️ Issues:
{{#each issues}}
- {{issue}}
{{/each}}

✅ Services OK: {{services_ok_count}}
```

## Phase 4: Update Dashboard
- `report_last_time`: current timestamp
- `report_count`: increment counter

## Guidelines
- Keep reports concise (3-5 lines max)
- Only alert on actual problems
- Skip if no changes from last report
- Don't spam if system is stable
