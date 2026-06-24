// Self-contained dashboard HTML served at GET /ui.
// No external assets — inline CSS + JS only. On load it fetches /api/jobs for a
// snapshot, then opens an EventSource('/api/stream') for live updates. Renders a
// per-job step tracker, live activity feed, PR link, and elapsed time.

export const PHASE1_STEPS = ["checkout", "overlay", "memory", "auto-impact", "review", "draft-pr"]
export const PHASE2_STEPS = ["checkout", "auto-implement", "finalize"]

export const dashboardHtml: string = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>zdc-harness — live dashboard</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --border: #30363d; --fg: #e6edf3;
    --muted: #8b949e; --accent: #58a6ff; --run: #d29922; --done: #3fb950;
    --fail: #f85149; --pending: #484f58;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.5 ui-monospace, "SF Mono", Menlo, monospace; }
  header { padding: 14px 20px; border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 12px; }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  #conn { font-size: 12px; color: var(--muted); }
  #conn.live { color: var(--done); }
  #conn.down { color: var(--fail); }
  main { padding: 16px 20px; display: grid; gap: 16px;
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); }
  .job { background: var(--panel); border: 1px solid var(--border);
    border-radius: 8px; padding: 14px; }
  .job h2 { font-size: 14px; margin: 0 0 4px; }
  .meta { color: var(--muted); font-size: 12px; margin-bottom: 10px;
    display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .badge { padding: 1px 7px; border-radius: 10px; font-size: 11px; text-transform: uppercase; }
  .badge.running { background: rgba(210,153,34,.15); color: var(--run); }
  .badge.done { background: rgba(63,185,80,.15); color: var(--done); }
  .badge.failed { background: rgba(248,81,73,.15); color: var(--fail); }
  .steps { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
  .step { font-size: 11px; padding: 2px 8px; border-radius: 4px;
    border: 1px solid var(--border); color: var(--muted); }
  .step.running { color: var(--run); border-color: var(--run); }
  .step.done { color: var(--done); border-color: var(--done); }
  .step.failed { color: var(--fail); border-color: var(--fail); }
  .step.pending { color: var(--pending); }
  .step .mark { margin-left: 4px; }
  .feed { background: #0a0d12; border: 1px solid var(--border); border-radius: 6px;
    max-height: 150px; overflow-y: auto; padding: 6px 8px; font-size: 12px; }
  .feed div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--muted); }
  .feed div .t { color: var(--accent); }
  a { color: var(--accent); }
  .empty { color: var(--muted); padding: 40px; text-align: center; }
</style>
</head>
<body>
<header>
  <h1>zdc-harness — live dashboard</h1>
  <span id="conn">connecting…</span>
</header>
<main id="jobs"><div class="empty" id="empty">No jobs yet.</div></main>
<script>
  var PHASE1 = ${JSON.stringify(PHASE1_STEPS)};
  var PHASE2 = ${JSON.stringify(PHASE2_STEPS)};
  var jobs = {};

  function expectedSteps(rec) {
    return rec.phase === "phase2" ? PHASE2 : PHASE1;
  }
  function statusOf(rec, name) {
    var s = (rec.steps || []).find(function (x) { return x.name === name; });
    return s ? s.status : "pending";
  }
  function fmtElapsed(rec) {
    if (!rec.startedAt) return "";
    var end = rec.updatedAt || Date.now();
    var sec = Math.max(0, Math.round((end - rec.startedAt) / 1000));
    var m = Math.floor(sec / 60), s = sec % 60;
    return (m ? m + "m " : "") + s + "s";
  }
  function esc(t) {
    return String(t == null ? "" : t).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function render() {
    var keys = Object.keys(jobs).sort(function (a, b) {
      return (jobs[b].updatedAt || 0) - (jobs[a].updatedAt || 0);
    });
    var main = document.getElementById("jobs");
    if (keys.length === 0) { main.innerHTML = '<div class="empty">No jobs yet.</div>'; return; }
    main.innerHTML = keys.map(function (k) {
      var rec = jobs[k];
      var steps = expectedSteps(rec).map(function (name) {
        var st = statusOf(rec, name);
        var mark = st === "done" ? "✓" : st === "failed" ? "✗" : "";
        return '<span class="step ' + st + '">' + esc(name) +
          (mark ? '<span class="mark">' + mark + "</span>" : "") + "</span>";
      }).join("");
      var feed = (rec.activity || []).slice().reverse().map(function (a) {
        var ts = new Date(a.ts).toLocaleTimeString();
        return '<div><span class="t">' + esc(ts) + "</span> " + esc(a.text) + "</div>";
      }).join("") || '<div>(no activity yet)</div>';
      var pr = rec.prUrl ? ' · <a href="' + esc(rec.prUrl) + '" target="_blank">PR</a>'
        : (rec.mrIid ? " · MR !" + esc(rec.mrIid) : "");
      var status = rec.status || "";
      var badge = ["running", "done", "failed"].indexOf(status) >= 0
        ? '<span class="badge ' + status + '">' + esc(status) + "</span>" : "";
      return '<div class="job">' +
        "<h2>" + esc(k) + "</h2>" +
        '<div class="meta">' + badge +
          "<span>" + esc(rec.phase || "") + "</span>" +
          "<span>⏱ " + fmtElapsed(rec) + "</span>" + pr + "</div>" +
        '<div class="steps">' + steps + "</div>" +
        '<div class="feed">' + feed + "</div>" +
        "</div>";
    }).join("");
  }

  function upsert(rec) {
    if (rec && rec.key) { jobs[rec.key] = rec; render(); }
  }

  fetch("/api/jobs").then(function (r) { return r.json(); }).then(function (list) {
    (list || []).forEach(upsert);
  }).catch(function () {});

  function connect() {
    var conn = document.getElementById("conn");
    var es = new EventSource("/api/stream");
    es.onopen = function () { conn.textContent = "live"; conn.className = "live"; };
    es.onmessage = function (e) {
      try { upsert(JSON.parse(e.data)); } catch (_) {}
    };
    es.onerror = function () {
      conn.textContent = "reconnecting…"; conn.className = "down";
    };
  }
  connect();
  // Refresh elapsed timers periodically.
  setInterval(render, 1000);
</script>
</body>
</html>`
