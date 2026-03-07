---
description: Build openclaw và restart gateway sau khi sửa TypeScript
---
Sau mỗi lần thay đổi code TypeScript (src/**/*.ts), luôn chạy 2 bước này theo thứ tự:

// turbo-all

1. Build project:

cd /home/hunglk/Documents/VSCode/AI-Agens/openclaw && pnpm build 

// turbo-all
2. Restart gateway service và verify active:

```bash
systemctl --user restart clawdis-gateway.service && sleep 2 && systemctl --user is-active clawdis-gateway.service
```

Nếu bước 1 có lỗi TypeScript, fix lỗi trước khi chạy bước 2.
Nếu bước 2 trả về `active` → thành công.
Nếu trả về `failed` → kiểm tra logs: `journalctl --user -u clawdis-gateway.service -n 30`
