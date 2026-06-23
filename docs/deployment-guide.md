# ZDC Harness — Deployment Guide

Hướng dẫn deploy harness v1: Docker + Redis + GitLab webhook. Harness gồm **2 tiến trình**: `server` (nhận webhook) và `worker` (xử lý job). Cùng dùng 1 Redis.

---

## 1. Yêu cầu (prerequisites)

| Thứ | Vì sao |
|---|---|
| **Node ≥ 20** | runtime harness |
| **Redis** | BullMQ queue + state store |
| **`claude` CLI** trên máy chạy **worker** | worker spawn `claude -p` để chạy agent bundle. Dùng **Claude subscription** — login 1 lần (`claude` → `/login`), credentials persist trong volume `claude-auth`. KHÔNG dùng API key |
| **git** trên worker | worker clone source repo + control-plane repo |
| **GitLab access token** scope `api` | tạo/sửa MR, comment |
| **Control-plane repo** đã clone sẵn trên worker | chứa `.claude/` shared + `be/ fe/` agent bundle (đường dẫn = `CONTROL_PLANE_DIR`) |

> ⚠️ **Quan trọng:** worker phải có `claude` CLI hoạt động + agent bundle thật (`/auto-impact`, `/auto-implement`, `/auto-review-solution`). Chưa có bundle thì chạy **dry-run** để test luồng.

## 2. Biến môi trường

| Biến | Bắt buộc | Mô tả |
|---|---|---|
| `GITLAB_TOKEN` | ✅ | token scope `api` |
| `GITLAB_URL` | ✅ | base URL GitLab (không trailing slash) |
| `WEBHOOK_SECRET` | ✅ | khớp `X-Gitlab-Token` trong webhook settings |
| `REDIS_URL` | ✅ | `redis://[:pass@]host:port[/db]` |
| `GITLAB_PROJECT_ID` | ✅ (worker) | project ID nơi tạo MR |
| `CONTROL_PLANE_DIR` | ✅ (worker) | path tới control-plane repo đã clone (chứa `.claude/` + bundle) |
| `SQLITE_MEMORY_DB` | nên có | path file sqlite memory (mặc định `:memory:` = mất khi restart → đặt path bền vd `/data/memory.sqlite`) |
| `PORT` | tùy | cổng server (mặc định 3000) |
| `DRY_RUN` | tùy | `1` = chỉ Phase 1 (impact+draft MR), KHÔNG code. Bật lúc đầu |
| `HARNESS_PAUSED` | tùy | `1` = kill-switch, worker giữ job không xử lý |

> **Claude auth (worker):** KHÔNG dùng `ANTHROPIC_API_KEY`. Dùng **Claude subscription** — sau khi deploy, vào worker container (Dokploy → Open Terminal) chạy `claude` rồi `/login` một lần. Credentials lưu ở `/root/.claude` (volume `claude-auth`), tồn tại qua restart/redeploy.

## 3. Entry points (cần thêm)

`server.ts`/`worker.ts` export `main()` nhưng chưa tự gọi. Thêm 2 file entry + scripts:

`src/start-server.ts`:
```ts
import { main } from "./server.js"
main().catch((e) => { console.error(e); process.exit(1) })
```
`src/start-worker.ts`:
```ts
import { main } from "./worker.js"
main().catch((e) => { console.error(e); process.exit(1) })
```
`package.json` scripts thêm:
```json
"start:server": "node dist/start-server.js",
"start:worker": "node dist/start-worker.js"
```
(build trước: `npm run build` → ra `dist/`.)

## 4. Chạy local (không Docker) — để test nhanh

```bash
# 1. Redis
docker run -d -p 6379:6379 --name zdc-redis redis:7-alpine

# 2. cấu hình
cp .env.example .env   # điền GITLAB_TOKEN, WEBHOOK_SECRET, ...
export $(grep -v '^#' .env | xargs)
export DRY_RUN=1       # an toàn cho lần đầu

# 3. build + chạy 2 tiến trình (2 terminal)
npm install && npm run build
npm run start:server   # terminal A
npm run start:worker   # terminal B
```

## 5. Docker

### Dockerfile
```dockerfile
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y git ca-certificates \
 && npm i -g @anthropic-ai/claude-code \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
# entrypoint do compose quyết (server hoặc worker)
```

### docker-compose.yml
```yaml
services:
  redis:
    image: redis:7-alpine
    volumes: [ "redis-data:/data" ]

  server:
    build: .
    command: node dist/start-server.js
    ports: [ "3000:3000" ]
    env_file: .env
    environment: { REDIS_URL: "redis://redis:6379" }
    depends_on: [ redis ]

  worker:
    build: .
    command: node dist/start-worker.js
    env_file: .env
    environment:
      REDIS_URL: "redis://redis:6379"
      CONTROL_PLANE_DIR: "/control-plane"
      SQLITE_MEMORY_DB: "/data/memory.sqlite"
    volumes:
      - "./control-plane:/control-plane:ro"   # control-plane repo (PRD+agent bundle)
      - "memory-data:/data"
      - "claude-auth:/root/.claude"           # Claude subscription auth (login 1 lần qua terminal)
    depends_on: [ redis ]
    # scale: docker compose up --scale worker=3

volumes: { redis-data: {}, memory-data: {}, claude-auth: {} }
```

> Worker cần `git` + `claude` CLI (đã cài trong image) + auth. Mount control-plane repo read-only; worker clone source repo vào thư mục tạm khi chạy.

## 6. Cấu hình GitLab webhook

Tại **mỗi repo cần auto** (Settings → Webhooks):
- **URL:** `https://<harness-host>/webhook`
- **Secret token:** = `WEBHOOK_SECRET`
- **Trigger events:** ✅ **Push events** (lọc theo tag commit) + ✅ **Comments** (Note events — để bắt `/approve` `/revise` `/reject` `/abort` trên MR)
- **SSL verification:** bật (harness nên sau reverse proxy TLS)

Test: push 1 commit lên **feature branch** với message chứa `[zdc:update-be PRD-1]` và đổi 1 file dưới `po/` → server trả 200, worker nhận job, tạo draft MR.

## 7. Checklist lần chạy đầu (an toàn)

1. `DRY_RUN=1` → chỉ sinh solution + draft MR, không code. Kiểm tra chất lượng impact/solution.
2. Khi tin tưởng → bỏ `DRY_RUN` (hoặc `=0`) để bật Phase 2 (auto code).
3. `HARNESS_PAUSED=1` bất cứ lúc nào để phanh khẩn (job giữ trong queue).
4. Đặt `SQLITE_MEMORY_DB` ra volume bền để memory không mất khi restart.

## 8. Vận hành

- **Scale worker:** `docker compose up --scale worker=N` (nhiều job song song; BullMQ chia việc).
- **Logs:** server in `listening on :PORT`; worker in `[worker] job <id> failed` khi lỗi.
- **Reverse proxy:** đặt server sau nginx/traefik với TLS; chỉ expose `/webhook`.
- **Bảo mật:** giữ `GITLAB_TOKEN` trong secret manager, không commit `.env`. Claude auth nằm trong volume `claude-auth` (không phải env).

## 9. Câu hỏi chưa giải

- **Auth `claude` trong container:** dùng **Claude subscription** — login 1 lần qua Open Terminal (`claude` → `/login`), persist trong volume `claude-auth`. Cần re-login khi credentials hết hạn.
- **Source repo checkout:** worker `git clone` mỗi job → cân nhắc cache/bare-clone cho repo lớn để giảm thời gian.
- **RedisStateStore** chưa có test tích hợp với Redis thật (chỉ InMemory được test) — nên smoke-test trước production.
- **Concurrency limit** cho worker pool chưa cấu hình tường minh (BullMQ mặc định) — đặt theo budget Claude.
- Agent bundle (`/auto-*` commands) là **điều kiện tiên quyết** để chạy thật — chưa có thì luồng chỉ chạy được ở chế độ stub/test.
