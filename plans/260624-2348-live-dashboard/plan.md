# Plan — Live status dashboard (SSE + activity feed)

**Mục tiêu:** UI realtime tại domain harness `/ui` cho thấy mỗi job đang ở **step nào** + **đang làm gì** (đọc/sửa file, chạy lệnh) trong step claude.

## Kiến trúc
```
worker mỗi mốc step + mỗi tool_use của claude
   → progress.report() ghi Redis (progress:<key>) + PUBLISH "progress"
server: GET /api/jobs (snapshot) · GET /api/stream (SSE, SUBSCRIBE redis) · GET /ui (static)
UI: EventSource('/api/stream') realtime + fetch /api/jobs lúc mở
```
jobKey = `<target>-<prd>` (vd `be-G3-F07`), bền qua phase1→phase2.

## Thành phần
1. **src/progress.ts** (+test): `report(key,patch)` cập nhật record {key,target,prd,phase,step,status,prUrl,mrIid,startedAt,updatedAt, steps[], activity[] (cap 40)} + zset index + PUBLISH. `list()`, `get(key)`. Dùng 1 ioredis client (publisher).
2. **src/claude-runner.ts**: chạy `--output-format stream-json --verbose`; parse JSONL; mỗi tool_use → `onActivity({tool,detail})`; lấy result text cuối làm `stdout` (GIỮ footer-parse cho Phase 2) + token usage. Backward-compat: `runner` injection vẫn dùng được; `onActivity` optional. Cập nhật test arg-assertion.
3. **pipelines**: thêm dep optional `reportStep(step,status)` gọi ở mốc (checkout/overlay/memory/impact/review · phase2: checkout/implement/finalize). No-op trong test.
4. **worker.ts**: tạo progress (publisher), tính jobKey, bind `onActivity`→progress.activity, `reportStep`→progress.step, report phase/done/failed; truyền vào pipelines + wrap runClaude.
5. **server.ts**: `/api/jobs`, `/api/stream` (SSE qua reply.raw + ioredis subscriber, heartbeat 15s, cleanup onClose), `/ui` (HTML self-contained). Headers SSE: text/event-stream, no-cache, X-Accel-Buffering:no.
6. **UI**: step tracker (danh sách step cố định/phase, bước hiện sáng, done✓/fail✗) + activity feed live + link PR + elapsed.

## Ràng buộc
- KHÔNG vỡ pipeline đang chạy: stream-json là superset, chỉ parse thêm. Phase 2 vẫn đọc footer từ result text.
- Giữ ≥168 test xanh + thêm test mới (progress, runner-stream-parse).
- Fallback: nếu proxy buffer SSE → UI vẫn poll /api/jobs (giữ endpoint).

## Bảo mật
- `/ui` public (demo). TODO sau: token che. (chưa làm)

## Câu hỏi mở
- Stream-json format theo claude 2.1.x: mỗi dòng JSON; tool_use nằm trong assistant message.content[]; event cuối `{"type":"result","result":...,"usage":...}`.
