---
summary: "Workspace template for TOOLS.md"
read_when:
  - Bootstrapping a workspace manually
---
# TOOLS.md - Local Notes

Skills define *how* tools work. This file is for *your* specifics — the stuff that's unique to your setup.

## What Goes Here

Things like:
- SSH hosts and aliases
- Server IPs and roles
- Kubernetes contexts and namespaces
- Docker registry URLs
- Monitoring/alerting endpoints
- Service port mappings
- Anything environment-specific

## Examples

```markdown
### SSH Hosts
- prod-web-01 → 10.0.1.10, user: deploy
- prod-db-01  → 10.0.1.20, user: postgres (read-only)
- staging     → 10.0.2.10, user: deploy

### Kubernetes
- prod-context    → gke_project_region_prod-cluster
- staging-context → gke_project_region_staging-cluster
- key namespaces: default, monitoring, ingress-nginx

### Services
- Grafana    → http://10.0.1.5:3000
- Prometheus → http://10.0.1.5:9090
- ArgoCD     → https://argocd.internal

### Docker
- registry → registry.internal:5000
- image naming: registry.internal:5000/{service}:{tag}
```

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet.
