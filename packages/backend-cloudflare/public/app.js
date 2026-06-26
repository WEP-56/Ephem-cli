// Admin 页面逻辑：创建房间、查询状态、销毁房间。
// 已创建的房间记录在 localStorage（后端没有"列出所有房间"的接口，因为房间分散在各自 DO 里）。

const $ = (id) => document.getElementById(id);
const adminKeyEl = $("adminKey");
const maxMembersEl = $("maxMembers");
const roomTypeEl = $("roomType");
const ttlEl = $("ttl");
const createBtn = $("createBtn");
const resultPanel = $("resultPanel");
const roomCodeOut = $("roomCodeOut");
const roomMetaOut = $("roomMetaOut");
const copyBtn = $("copyBtn");
const roomListEl = $("roomList");
const toastEl = $("toast");

const STORE_KEY = "ephem.rooms";
const KEY_STORE = "ephem.adminKey";

// 恢复管理密码
adminKeyEl.value = localStorage.getItem(KEY_STORE) ?? "";
adminKeyEl.addEventListener("change", () => {
  localStorage.setItem(KEY_STORE, adminKeyEl.value);
});
roomTypeEl.addEventListener("change", () => {
  ttlEl.disabled = roomTypeEl.value === "persistent";
});

function adminKey() { return adminKeyEl.value.trim(); }
function getRooms() { try { return JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]"); } catch { return []; } }
function saveRooms(list) { localStorage.setItem(STORE_KEY, JSON.stringify(list)); }
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  setTimeout(() => toastEl.classList.remove("show"), 1800);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", "X-Admin-Key": adminKey(), ...(opts.headers ?? {}) },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  return { ok: res.ok, status: res.status, data };
}

// ── 创建房间 ──────────────────────────────────────
createBtn.addEventListener("click", async () => {
  if (!adminKey()) { toast("请先填写管理密码"); adminKeyEl.focus(); return; }
  createBtn.disabled = true;
  createBtn.textContent = "创建中…";
  const body = {
    maxMembers: parseInt(maxMembersEl.value, 10) || 2,
    roomType: roomTypeEl.value === "persistent" ? "persistent" : "ephemeral",
    ttlSeconds: parseInt(ttlEl.value, 10) || 3600,
  };
  const r = await api("/api/rooms", { method: "POST", body: JSON.stringify(body) });
  createBtn.disabled = false;
  createBtn.textContent = "创建房间";
  if (!r.ok) { toast(r.data?.error ?? `创建失败 (${r.status})`); return; }

  const { roomCode, expiresAt, maxMembers, roomType, ttlSeconds } = r.data;
  resultPanel.style.display = "";
  roomCodeOut.textContent = roomCode;
  roomMetaOut.innerHTML = roomType === "persistent"
    ? `长期房间 · 人数上限 <b>${maxMembers}</b> · 保存轻量文本记录`
    : `人数上限 <b>${maxMembers}</b> · 销毁时间 <b>${fmtTime(expiresAt)}</b> · 剩余 <b id="cd">${fmtCountdown(expiresAt)}</b>`;

  // 记录到本地并刷新列表
  const rooms = getRooms().filter((x) => x.code !== roomCode);
  rooms.unshift({ code: roomCode, expiresAt, maxMembers, ttlSeconds, roomType, createdAt: Date.now() });
  saveRooms(rooms);
  renderList();
  if (roomType === "persistent") clearInterval(cdTimer);
  else startCountdown(expiresAt);
  toast("房间已创建");
});

copyBtn.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(roomCodeOut.textContent); toast("已复制到剪贴板"); }
  catch { toast("复制失败，请手动选中"); }
});

// ── 房间列表 ──────────────────────────────────────
async function renderList() {
  const rooms = getRooms();
  if (rooms.length === 0) {
    roomListEl.innerHTML = '<div class="empty">还没有房间</div>';
    return;
  }
  // 查询每个房间的最新状态
  const items = await Promise.all(
    rooms.map(async (r) => {
      const s = await api(`/api/rooms/${encodeURIComponent(r.code)}/status`);
      return { ...r, status: s.data, ok: s.ok };
    }),
  );
  // 清掉已不存在的房间
  const alive = items.filter((x) => x.ok && x.status?.alive !== false && x.status?.error !== "not_found");
  // 保留查询失败但本地记录未过期的（可能是网络问题），过期的清掉
  const keep = items.filter((x) => !(x.ok && (x.status?.error === "not_found" || x.status?.alive === false)));
  saveRooms(keep.map(({ code, expiresAt, maxMembers, ttlSeconds, roomType, createdAt }) => ({ code, expiresAt, maxMembers, ttlSeconds, roomType, createdAt })));

  roomListEl.innerHTML = keep
    .map((x) => {
      const s = x.status ?? {};
      const live = s.alive === true;
      const roomType = s.roomType ?? x.roomType ?? "ephemeral";
      const members = s.currentMembers ?? "—";
      const max = s.maxMembers ?? x.maxMembers ?? "—";
      const left = !live ? "已销毁" : roomType === "persistent" ? `长期 · 历史 ${s.historyCount ?? 0} 条` : fmtCountdown(s.expiresAt ?? x.expiresAt);
      return `
        <div class="room-item">
          <div>
            <div class="code">${esc(x.code)}</div>
            <div class="stat">${members}/${max} 人 · ${left}</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <span class="pill ${live ? "live" : "dead"}">${live ? "活跃" : "已结束"}</span>
            <button class="ghost danger" data-code="${esc(x.code)}">销毁</button>
          </div>
        </div>`;
    })
    .join("");

  roomListEl.querySelectorAll("button[data-code]").forEach((btn) => {
    btn.addEventListener("click", () => destroyRoom(btn.dataset.code));
  });
}

async function destroyRoom(code) {
  if (!confirm(`确定销毁房间 ${code}？所有成员会被断开。`)) return;
  const r = await api(`/api/rooms/${encodeURIComponent(code)}`, { method: "DELETE" });
  if (!r.ok) { toast(r.data?.error ?? "销毁失败"); return; }
  toast("房间已销毁");
  renderList();
}

// ── 工具函数 ──────────────────────────────────────
function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}
function fmtCountdown(expiresAt) {
  const left = Math.max(0, expiresAt - Date.now());
  const h = Math.floor(left / 3600000);
  const m = Math.floor((left % 3600000) / 60000);
  const s = Math.floor((left % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// 新建房间结果面板的倒计时
let cdTimer = null;
function startCountdown(expiresAt) {
  clearInterval(cdTimer);
  cdTimer = setInterval(() => {
    const el = $("cd");
    if (!el) { clearInterval(cdTimer); return; }
    el.textContent = fmtCountdown(expiresAt);
  }, 1000);
}

// 初始渲染 + 定时刷新列表
renderList();
setInterval(renderList, 15000);
