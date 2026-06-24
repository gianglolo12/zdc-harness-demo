# Cách trigger workflow ZDC Harness

> Tài liệu cho team. Harness tự động hoá: **PRD → phân tích tác động → bạn duyệt → code + test → Pull Request**.
> Bạn chỉ cần "ra lệnh" — harness lo phần còn lại và mở PR trên repo source.

## TL;DR
1. **PO/BA**: mở 1 **GitHub Issue** trên repo control-plane, tiêu đề `[zdc:update-be <PRD-ID>]`.
2. Harness comment *"đã nhận"* rồi mở **draft PR** (kèm phân tích tác động) trên repo BE.
3. **Dev**: đọc PR, comment **`/approve`** → harness code + test + đẩy commit, bỏ nháp.
4. **Dev**: review + **merge** PR như bình thường → Issue tự đóng.

---

## Khái niệm (3 repo)
| Repo | Là gì |
|---|---|
| **control-plane** (`zdc-control-plane`) | Nơi chứa PRD (`po/`) + tài liệu kỹ thuật BE (`be/<PRD>/`) + "bộ não" agent. **Bạn trigger ở đây.** |
| **source** (`zdc-be-demo`) | Code thật. **PR mở ở đây.** |
| **harness** | Server tự động (không cần đụng tới). |

---

## Cách 1 — GitHub Issue ⭐ (khuyên dùng, hợp PO)
Không cần git, không sửa file.

1. Vào repo **control-plane** → tab **Issues** → **New issue**.
2. **Tiêu đề** đặt đúng cú pháp tag:
   ```
   [zdc:update-be G3-F07]
   ```
3. Body ghi gì cũng được (mô tả thêm nếu muốn). Bấm **Submit**.
4. Trong ~30s, Issue sẽ có comment: *"🤖 Đã nhận — đang phân tích `G3-F07`..."*.
5. Vài phút sau, **draft PR** xuất hiện trên repo **source** (tiêu đề `Impact analysis: G3-F07 → be`).

## Cách 2 — Push (khi đang sửa chính nội dung PRD)
Dùng khi bạn vừa cập nhật 1 PRD và muốn trigger luôn.

1. Trên repo control-plane, tạo **feature branch** (KHÔNG phải `main`).
2. Sửa/them file dưới `po/**`, commit với message chứa tag:
   ```bash
   git commit -m "docs(po): cập nhật G3-F07 [zdc:update-be G3-F07]"
   git push origin <feature-branch>
   ```
3. Phần còn lại giống Cách 1.

> Lưu ý: push thẳng vào `main` **không** trigger (tránh kích hoạt khi merge). Phải là feature branch.

---

## Cú pháp tag
```
[zdc:update-<role> <PRD-ID>]
```
- `<role>`: `be` (backend), `fe` (frontend), `qa`. *(hiện đã wire `be`)*
- `<PRD-ID>`: id feature, vd `G3-F07`, `G3-F08`, `G4-F11` (gạch nối, không dấu chấm).

Ví dụ:
```
[zdc:update-be G3-F07]      → BE làm feature Tạo đơn hàng
[zdc:update-be G4-F11]      → BE làm feature Tra cứu thẻ
```

---

## Cổng duyệt — comment trên PR
Sau khi draft PR mở, **dev** điều khiển bằng cách comment lên PR đó:

| Comment | Tác dụng |
|---|---|
| `/approve` | Đồng ý phân tích → harness code + test + đẩy commit, bỏ nháp PR |
| `/revise <góp ý>` | Yêu cầu phân tích lại kèm góp ý (tối đa 3 lần) |
| `/reject` | Từ chối — dừng, không code |
| `/abort` | Huỷ job |

Comment thường (không có lệnh) → bị bỏ qua.

---

## Vòng đời đầy đủ (ví dụ G3-F07)
```
PO: New Issue "[zdc:update-be G3-F07]"
        │
        ▼
Harness: comment "🤖 Đã nhận…"  →  mở draft PR #N trên zdc-be-demo
        │                              (phân tích tác động: đọc PRD + FRS + api-contract)
        ▼
Dev: đọc PR #N  →  comment "/approve"
        │
        ▼
Harness: /auto-implement → viết code Spring Boot + mvn test + push  →  PR hết nháp
        │
        ▼
Dev: review PR #N  →  Merge
        │
        ▼
Harness: đóng Issue + comment evidence trên PR
```

---

## Câu hỏi thường gặp
- **PR mở ở đâu?** Trên repo **source** (BE), không phải control-plane.
- **Bao lâu?** Phân tích ~2-4 phút; code (sau approve) vài phút–chục phút tuỳ độ lớn feature.
- **Agent đọc gì khi làm?** PRD (`po/`) **và** tài liệu kỹ thuật BE (`be/<PRD>/` gồm FRS + `api-contract.yaml` + diagrams). Hai nguồn được kết hợp.
- **Muốn đổi cách BE code (convention, rule)?** Sửa bundle `be/` trong control-plane (`be/rules/*`, `be/CLAUDE.md`, `be/commands/*`) rồi push — có hiệu lực ngay job kế (không cần deploy lại harness).
- **Một feature quá lớn?** Nên chia nhỏ PRD/feature khi dispatch để PR dễ review.

---

## Lưu ý vận hành (cho người quản trị)
- Cần webhook trên cả 2 repo: control-plane (`push`, `issues`) và source (`issue_comment`, `pull_request`).
- `DRY_RUN=1`: chỉ phân tích, không tạo PR/không push (chế độ thử).
- `HARNESS_PAUSED=1`: tạm dừng toàn bộ (kill-switch).
