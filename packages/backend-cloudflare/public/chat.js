const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_MAX_EDGE = 2560;
const THUMB_MAX_EDGE = 640;
const SALT = "ephem-v1-room-salt";
const INFO = "ephem-room-encryption-key";

const $ = (id) => document.getElementById(id);

const connectView = $("connectView");
const chatView = $("chatView");
const archiveView = $("archiveView");
const connectForm = $("connectForm");
const roomCodeEl = $("roomCode");
const usernameEl = $("username");
const joinBtn = $("joinBtn");
const connectError = $("connectError");
const roomTitle = $("roomTitle");
const roomMeta = $("roomMeta");
const connState = $("connState");
const leaveBtn = $("leaveBtn");
const messageList = $("messageList");
const messageForm = $("messageForm");
const messageInput = $("messageInput");
const sendBtn = $("sendBtn");
const imageBtn = $("imageBtn");
const imageInput = $("imageInput");
const loadHistoryBtn = $("loadHistoryBtn");
const exportBtn = $("exportBtn");
const chatTab = $("chatTab");
const archiveTab = $("archiveTab");
const archiveList = $("archiveList");
const archiveViewer = $("archiveViewer");
const archiveImportInput = $("archiveImportInput");
const archiveImportBtn = $("archiveImportBtn");
const archiveBackBtn = $("archiveBackBtn");
const imageLightbox = $("imageLightbox");
const lightboxImage = $("lightboxImage");
const lightboxMeta = $("lightboxMeta");
const lightboxClose = $("lightboxClose");

const ARCHIVE_STORE = "ephem.web.archives";
const CLIENT_ID_STORE = "ephem.web.clientId";
const clientId = getClientId();

let ws = null;
let roomKey = null;
let roomCode = "";
let username = "";
let joinedInfo = null;
let closing = false;
let pingTimer = null;
let countdownTimer = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let manuallyClosed = false;
let transcript = [];
let currentView = "chat";
let historyBefore = null;
let historyHasMore = false;
let historyLoading = false;
const seenHistoryIds = new Set();

connectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = roomCodeEl.value.trim().toLowerCase();
  const name = usernameEl.value.trim() || "匿名";
  if (!/^[a-z]+-[a-z]+-[a-z]+$/.test(code)) {
    setConnectError("房间码格式应为三段英文单词，例如 correct-horse-battery");
    return;
  }
  joinBtn.disabled = true;
  setConnectError("");
  try {
    roomCode = code;
    username = name.slice(0, 32);
    roomKey = await deriveRoomKey(roomCode);
    openSocket();
  } catch (err) {
    setConnectError(err instanceof Error ? err.message : String(err));
    joinBtn.disabled = false;
  }
});

leaveBtn.addEventListener("click", () => leaveRoom());

messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text || closing) return;
  if (!isSocketOpen()) {
    addSystem("连接未就绪，正在等待重连", "warn");
    return;
  }
  sendBtn.disabled = true;
  try {
    await sendPlaintext(JSON.stringify({ v: 1, kind: "text", text }));
    addTextMessage(username, text, true, Date.now(), true);
    messageInput.value = "";
    resizeComposer();
  } catch (err) {
    addSystem(`发送失败：${err instanceof Error ? err.message : String(err)}`, "error");
  } finally {
    sendBtn.disabled = false;
  }
});

messageInput.addEventListener("input", resizeComposer);
messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    messageForm.requestSubmit();
  }
});

imageBtn.addEventListener("click", () => {
  if (!closing) imageInput.click();
});

imageInput.addEventListener("change", async () => {
  const file = imageInput.files?.[0];
  imageInput.value = "";
  if (!file || closing) return;
  if (!isSocketOpen()) {
    addSystem("连接未就绪，正在等待重连", "warn");
    return;
  }
  imageBtn.disabled = true;
  try {
    const image = await prepareImageMessage(file);
    await sendPlaintext(JSON.stringify(image), false);
    addImageMessage(username, image, true, Date.now(), true);
  } catch (err) {
    addSystem(`发送图片失败：${err instanceof Error ? err.message : String(err)}`, "error");
  } finally {
    imageBtn.disabled = false;
  }
});
loadHistoryBtn.addEventListener("click", () => requestOlderHistory());
messageList.addEventListener("scroll", () => {
  if (messageList.scrollTop < 160) requestOlderHistory();
});

exportBtn.addEventListener("click", () => exportCurrentTranscript());
chatTab.addEventListener("click", () => showMainView("chat"));
archiveTab.addEventListener("click", () => showMainView("archive"));
archiveImportBtn.addEventListener("click", () => archiveImportInput.click());
archiveBackBtn.addEventListener("click", () => {
  if (!archiveViewer.hidden) {
    renderArchiveList();
  } else {
    showMainView("chat");
  }
});
archiveImportInput.addEventListener("change", async () => {
  const file = archiveImportInput.files?.[0];
  archiveImportInput.value = "";
  if (!file) return;
  try {
    const archive = await readEphemArchive(file);
    saveArchive(archive);
    renderArchiveList();
    showMainView("archive");
  } catch (err) {
    addSystem(`导入失败：${err instanceof Error ? err.message : String(err)}`, "error");
  }
});
lightboxClose.addEventListener("click", closeLightbox);
imageLightbox.addEventListener("click", (event) => {
  if (event.target === imageLightbox) closeLightbox();
});

function openSocket() {
  manuallyClosed = false;
  closing = false;
  setConnectionState("连接中", true);
  setComposerEnabled(false);
  const url = `${wsBase()}/room/${encodeURIComponent(roomCode)}?username=${encodeURIComponent(username)}&clientId=${encodeURIComponent(clientId)}`;
  ws = new WebSocket(url);

  ws.addEventListener("open", () => {
    reconnectAttempt = 0;
    startPing();
  });

  ws.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(String(event.data));
      void dispatchServerMessage(msg);
    } catch {
      // Ignore malformed frames.
    }
  });

  ws.addEventListener("close", () => {
    stopPing();
    setComposerEnabled(false);
    if (manuallyClosed || closing) return;
    if (!joinedInfo) {
      setConnectError("连接失败：房间不存在、已满、已过期，或网络不可用");
      joinBtn.disabled = false;
      setConnectionState("连接失败", true);
      return;
    }
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    if (!joinedInfo) setConnectError("连接失败：请检查房间码和后端状态");
    setConnectionState("连接异常", true);
  });
}

async function dispatchServerMessage(msg) {
  switch (msg.type) {
    case "joined":
      joinedInfo = msg.payload;
      showChat();
      updateHeader();
      startCountdown();
      setConnectionState("已连接", false);
      setComposerEnabled(true);
      addSystem(`已加入房间 ${roomCode}（${joinedInfo.currentMembers}/${joinedInfo.maxMembers} 人）`);
      break;
    case "peer_joined":
      if (joinedInfo) joinedInfo.currentMembers += 1;
      updateHeader();
      addSystem(`${msg.payload?.username ?? "有人"} 加入了房间`);
      break;
    case "peer_left":
      if (joinedInfo) joinedInfo.currentMembers = Math.max(0, joinedInfo.currentMembers - 1);
      updateHeader();
      addSystem(`${msg.payload?.username ?? "有人"} 离开了房间`);
      break;
    case "message":
      await handleEncryptedMessage(msg.payload ?? {});
      break;
    case "history":
      await handleHistory(msg.payload ?? {});
      break;
    case "room_closing":
      closing = true;
      setConnectionState("房间关闭中", true);
      addSystem(`房间即将关闭：${reasonText(msg.payload?.reason)}`, "warn");
      setTimeout(() => leaveRoom(), 1500);
      break;
    case "error":
      addSystem(`错误：${msg.payload?.message ?? msg.payload?.code ?? "unknown"}`, "error");
      break;
  }
}

async function handleEncryptedMessage(payload) {
  try {
    const plaintext = await decryptMessage(payload.ciphertext, payload.nonce);
    const parsed = parsePlaintext(plaintext);
    if (parsed.kind === "image") addImageMessage(payload.from ?? "未知", parsed, false, payload.timestamp ?? Date.now(), true);
    else addTextMessage(payload.from ?? "未知", parsed.text, false, payload.timestamp ?? Date.now(), true);
  } catch {
    addSystem(`收到来自 ${payload.from ?? "未知"} 的无法解密的消息`, "warn");
  }
}

async function handleHistory(payload) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  historyBefore = payload.before ?? historyBefore;
  historyHasMore = Boolean(payload.hasMore);
  loadHistoryBtn.hidden = !historyHasMore;
  historyLoading = false;
  loadHistoryBtn.disabled = false;
  loadHistoryBtn.textContent = "加载更早记录";
  if (!Array.isArray(messages) || messages.length === 0) return;
  const anchor = messageList.scrollHeight;
  for (const item of [...messages].reverse()) {
    if (item.id && seenHistoryIds.has(item.id)) continue;
    try {
      const plaintext = await decryptMessage(item.ciphertext, item.nonce);
      const parsed = parsePlaintext(plaintext);
      if (parsed.kind === "text") {
        if (item.id) seenHistoryIds.add(item.id);
        addTextMessage(item.from ?? "未知", parsed.text, (item.from ?? "") === username, item.timestamp ?? Date.now(), true, true, true);
      }
    } catch {
      addSystem(`一条历史记录无法解密`, "warn");
    }
  }
  messageList.scrollTop = messageList.scrollHeight - anchor;
}

async function sendPlaintext(plaintext, persist = true) {
  if (!isSocketOpen()) throw new Error("连接未就绪");
  const encrypted = await encryptMessage(plaintext);
  ws.send(JSON.stringify({ type: "message", payload: { ...encrypted, persist } }));
}

async function deriveRoomKey(code) {
  const ikm = await crypto.subtle.importKey("raw", utf8(code), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: utf8(SALT), info: utf8(INFO) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptMessage(plaintext) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const combined = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, roomKey, utf8(plaintext));
  return {
    ciphertext: bytesToBase64(new Uint8Array(combined)),
    nonce: bytesToBase64(nonce),
  };
}

async function decryptMessage(ciphertext, nonce) {
  const combined = base64ToBytes(ciphertext);
  const nonceBytes = base64ToBytes(nonce);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonceBytes, tagLength: 128 }, roomKey, combined);
  return new TextDecoder().decode(plain);
}

function parsePlaintext(plaintext) {
  try {
    const msg = JSON.parse(plaintext);
    if (msg?.v === 1 && msg.kind === "text" && typeof msg.text === "string") return msg;
    if (msg?.v === 1 && msg.kind === "image" && typeof msg.data === "string") return msg;
  } catch {
    // Old clients encrypt plain strings.
  }
  return { kind: "text", text: plaintext };
}

async function prepareImageMessage(file) {
  if (!file.type.startsWith("image/")) throw new Error("仅支持图片文件");
  if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)) {
    throw new Error("仅支持 jpg/png/webp/gif");
  }
  if (file.type === "image/gif") {
    if (file.size > IMAGE_MAX_BYTES) throw new Error(`GIF 不能超过 ${formatBytes(IMAGE_MAX_BYTES)}`);
    return {
      v: 1,
      kind: "image",
      mime: file.type,
      name: file.name,
      size: file.size,
      data: await blobToBase64(file),
    };
  }

  const bitmap = await createImageBitmap(file);
  const mainBlob = await renderImage(bitmap, IMAGE_MAX_EDGE, "image/jpeg", 0.92);
  if (mainBlob.size > IMAGE_MAX_BYTES) throw new Error(`压缩后仍超过 ${formatBytes(IMAGE_MAX_BYTES)}`);
  const thumbBlob = await renderImage(bitmap, THUMB_MAX_EDGE, "image/jpeg", 0.82);
  const mainSize = fitSize(bitmap.width, bitmap.height, IMAGE_MAX_EDGE);
  const thumbSize = fitSize(bitmap.width, bitmap.height, THUMB_MAX_EDGE);

  return {
    v: 1,
    kind: "image",
    mime: mainBlob.type || "image/jpeg",
    name: file.name,
    size: mainBlob.size,
    width: mainSize.width,
    height: mainSize.height,
    data: await blobToBase64(mainBlob),
    thumb: {
      mime: thumbBlob.type || "image/jpeg",
      width: thumbSize.width,
      height: thumbSize.height,
      data: await blobToBase64(thumbBlob),
    },
  };
}

async function renderImage(bitmap, maxEdge, mime, quality) {
  const size = fitSize(bitmap.width, bitmap.height, maxEdge);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, size.width, size.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("图片压缩失败"))), mime, quality);
  });
}

function fitSize(width, height, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function addSystem(text, level = "info") {
  const el = document.createElement("div");
  el.className = `system ${level}`;
  el.textContent = text;
  messageList.append(el);
  scrollToBottom();
}

function addTextMessage(from, text, mine, timestamp = Date.now(), record = true, historical = false, prepend = false) {
  const bubble = messageBubble(from, mine);
  const body = document.createElement("div");
  body.className = "text";
  body.textContent = text;
  bubble.append(body, timeEl(timestamp));
  if (prepend) messageList.insertBefore(bubble, loadHistoryBtn.nextSibling);
  else messageList.append(bubble);
  if (historical) bubble.classList.add("historical");
  if (record) recordMessage({ kind: "text", from, text, mine, timestamp });
  if (!prepend) scrollToBottom();
}

function addImageMessage(from, image, mine, timestamp = Date.now(), record = true) {
  const bubble = messageBubble(from, mine);
  const img = document.createElement("img");
  img.className = "image-preview";
  img.alt = image.name || "image";
  img.src = imageToUrl(image.thumb || image);
  img.addEventListener("click", () => openLightbox(image));
  if (image.width && image.height) {
    img.width = Math.min(image.width, 420);
    img.height = Math.round((img.width / image.width) * image.height);
  }
  const meta = document.createElement("div");
  meta.className = "image-meta";
  meta.textContent = `${image.name ? `${image.name} · ` : ""}${formatBytes(image.size)} · ${image.mime}`;
  bubble.append(img, meta, timeEl(timestamp));
  messageList.append(bubble);
  if (record) recordMessage({ kind: "image", from, image, mine, timestamp });
  scrollToBottom();
}

function requestOlderHistory() {
  if (historyLoading || !historyHasMore || !ws || ws.readyState !== WebSocket.OPEN) return;
  historyLoading = true;
  loadHistoryBtn.disabled = true;
  loadHistoryBtn.textContent = "加载中…";
  ws.send(JSON.stringify({ type: "history_request", payload: { before: historyBefore, limit: 50 } }));
  setTimeout(() => {
    historyLoading = false;
    loadHistoryBtn.disabled = false;
    loadHistoryBtn.textContent = "加载更早记录";
  }, 1200);
}

function messageBubble(from, mine) {
  const bubble = document.createElement("article");
  bubble.className = `bubble${mine ? " mine" : ""}`;
  if (!mine) {
    const sender = document.createElement("div");
    sender.className = "sender";
    sender.textContent = from;
    bubble.append(sender);
  }
  return bubble;
}

function timeEl(timestamp = Date.now()) {
  const el = document.createElement("div");
  el.className = "time";
  el.textContent = new Date(timestamp).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit", month: "2-digit", day: "2-digit" });
  return el;
}

function showChat() {
  connectView.hidden = true;
  chatView.hidden = false;
  archiveView.hidden = true;
  chatTab.hidden = false;
  archiveTab.hidden = false;
  setTab("chat");
  joinBtn.disabled = false;
  messageInput.focus();
}

function leaveRoom() {
  manuallyClosed = true;
  stopPing();
  clearTimeout(reconnectTimer);
  clearInterval(countdownTimer);
  ws?.close();
  ws = null;
  roomKey = null;
  joinedInfo = null;
  closing = false;
  setComposerEnabled(true);
  transcript = [];
  seenHistoryIds.clear();
  historyBefore = null;
  historyHasMore = false;
  historyLoading = false;
  messageList.replaceChildren();
  chatView.hidden = true;
  archiveView.hidden = true;
  connectView.hidden = false;
  chatTab.hidden = true;
  archiveTab.hidden = true;
  joinBtn.disabled = false;
}

function scheduleReconnect() {
  reconnectAttempt += 1;
  const delay = Math.min(1000 * 2 ** (reconnectAttempt - 1), 30000);
  setConnectionState(`重连中，${Math.ceil(delay / 1000)}s`, true);
  addSystem(`连接断开，准备第 ${reconnectAttempt} 次重连`, "warn");
  reconnectTimer = setTimeout(() => openSocket(), delay);
}

function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
  }, 25000);
}

function stopPing() {
  clearInterval(pingTimer);
  pingTimer = null;
}

function startCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = setInterval(updateHeader, 1000);
}

function updateHeader() {
  if (!joinedInfo) return;
  roomTitle.textContent = roomCode;
  if (joinedInfo.roomType === "persistent") {
    roomMeta.textContent = `${joinedInfo.currentMembers}/${joinedInfo.maxMembers} 人 · 长期房间`;
    return;
  }
  const left = Math.max(0, (joinedInfo.expiresAt ?? Date.now()) - Date.now());
  roomMeta.textContent = `${joinedInfo.currentMembers}/${joinedInfo.maxMembers} 人 · 剩余 ${formatDuration(left)}`;
}

function setConnectionState(text, warn) {
  connState.textContent = text;
  connState.classList.toggle("warn", Boolean(warn));
}

function setConnectError(text) {
  connectError.textContent = text;
}

function setComposerEnabled(enabled) {
  messageInput.disabled = !enabled;
  sendBtn.disabled = !enabled;
  imageBtn.disabled = !enabled;
}

function isSocketOpen() {
  return ws?.readyState === WebSocket.OPEN;
}

function getClientId() {
  try {
    const existing = localStorage.getItem(CLIENT_ID_STORE);
    if (existing) return existing;
    const id = `web-${crypto.randomUUID()}`;
    localStorage.setItem(CLIENT_ID_STORE, id);
    return id;
  } catch {
    return `web-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  }
}

function resizeComposer() {
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 120)}px`;
}

function scrollToBottom() {
  messageList.scrollTop = messageList.scrollHeight;
}

function wsBase() {
  const url = new URL(location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function imageToUrl(image) {
  const bytes = base64ToBytes(image.data);
  return URL.createObjectURL(new Blob([bytes], { type: image.mime }));
}

function openLightbox(image) {
  lightboxImage.src = imageToUrl(image);
  lightboxImage.alt = image.name || "image";
  lightboxMeta.textContent = `${image.name ? `${image.name} · ` : ""}${formatBytes(image.size)} · ${image.mime}`;
  imageLightbox.hidden = false;
}

function closeLightbox() {
  imageLightbox.hidden = true;
  lightboxImage.removeAttribute("src");
}

function recordMessage(message) {
  transcript.push(message);
  if (transcript.length > 1000) transcript = transcript.slice(-1000);
}

function showMainView(view) {
  currentView = view;
  connectView.hidden = true;
  chatView.hidden = view !== "chat";
  archiveView.hidden = view !== "archive";
  setTab(view);
  if (view === "archive") renderArchiveList();
}

function setTab(view) {
  chatTab.classList.toggle("active", view === "chat");
  archiveTab.classList.toggle("active", view === "archive");
}

async function exportCurrentTranscript() {
  if (transcript.length === 0) {
    addSystem("当前没有可导出的聊天记录", "warn");
    return;
  }
  const archive = {
    format: "ephem.archive",
    version: 1,
    title: `${roomCode} ${new Date().toLocaleString("zh-CN")}`,
    roomCode,
    exportedAt: Date.now(),
    messages: transcript,
  };
  const bytes = await encodeEphemArchive(archive);
  downloadBytes(bytes, `${roomCode}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.ephem`);
  saveArchive(archive);
  renderArchiveList();
}

async function encodeEphemArchive(archive) {
  const bytes = utf8(JSON.stringify(archive));
  if (!("CompressionStream" in window)) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readEphemArchive(file) {
  let bytes = new Uint8Array(await file.arrayBuffer());
  if ("DecompressionStream" in window) {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      // 允许导入未压缩 JSON，便于调试和兼容。
    }
  }
  const archive = JSON.parse(new TextDecoder().decode(bytes));
  if (archive?.format !== "ephem.archive" || !Array.isArray(archive.messages)) {
    throw new Error("不是有效的 .ephem 记录文件");
  }
  archive.importedAt = Date.now();
  return archive;
}

function downloadBytes(bytes, filename) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function getArchives() {
  try { return JSON.parse(localStorage.getItem(ARCHIVE_STORE) ?? "[]"); } catch { return []; }
}

function saveArchive(archive) {
  const archives = getArchives().filter((item) => item.exportedAt !== archive.exportedAt);
  archives.unshift(archive);
  localStorage.setItem(ARCHIVE_STORE, JSON.stringify(archives.slice(0, 20)));
}

function deleteArchive(exportedAt) {
  localStorage.setItem(ARCHIVE_STORE, JSON.stringify(getArchives().filter((item) => item.exportedAt !== exportedAt)));
  renderArchiveList();
}

function renderArchiveList() {
  archiveList.hidden = false;
  archiveViewer.hidden = true;
  const archives = getArchives();
  if (archives.length === 0) {
    archiveList.innerHTML = '<div class="empty">还没有导入或导出的记录</div>';
    return;
  }
  archiveList.replaceChildren();
  for (const archive of archives) {
    const item = document.createElement("div");
    item.className = "archive-item";
    const info = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = archive.title || archive.roomCode || "Ephem 记录";
    const meta = document.createElement("span");
    meta.textContent = `${archive.messages?.length ?? 0} 条 · ${new Date(archive.exportedAt || archive.importedAt || Date.now()).toLocaleString("zh-CN")}`;
    info.append(title, meta);
    const actions = document.createElement("div");
    actions.className = "archive-actions";
    const view = document.createElement("button");
    view.className = "ghost-btn";
    view.textContent = "查看";
    view.addEventListener("click", () => viewArchive(archive));
    const del = document.createElement("button");
    del.className = "ghost-btn";
    del.textContent = "删除";
    del.addEventListener("click", () => deleteArchive(archive.exportedAt));
    actions.append(view, del);
    item.append(info, actions);
    archiveList.append(item);
  }
}

function viewArchive(archive) {
  archiveList.hidden = true;
  archiveViewer.hidden = false;
  archiveViewer.replaceChildren();
  const title = document.createElement("div");
  title.className = "system";
  title.textContent = `${archive.title || archive.roomCode || "Ephem 记录"} · ${archive.messages.length} 条`;
  archiveViewer.append(title);
  for (const message of archive.messages) {
    if (message.kind === "image") appendArchiveImage(archiveViewer, message);
    else appendArchiveText(archiveViewer, message);
  }
}

function appendArchiveText(container, message) {
  const bubble = messageBubble(message.from, message.mine);
  const body = document.createElement("div");
  body.className = "text";
  body.textContent = message.text ?? "";
  bubble.append(body, timeEl(message.timestamp));
  container.append(bubble);
}

function appendArchiveImage(container, message) {
  const image = message.image;
  if (!image) return;
  const bubble = messageBubble(message.from, message.mine);
  const img = document.createElement("img");
  img.className = "image-preview";
  img.alt = image.name || "image";
  img.src = imageToUrl(image.thumb || image);
  img.addEventListener("click", () => openLightbox(image));
  const meta = document.createElement("div");
  meta.className = "image-meta";
  meta.textContent = `${image.name ? `${image.name} · ` : ""}${formatBytes(image.size)} · ${image.mime}`;
  bubble.append(img, meta, timeEl(message.timestamp));
  container.append(bubble);
}

async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  return bytesToBase64(new Uint8Array(buf));
}

function utf8(text) {
  return new TextEncoder().encode(text);
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatDuration(ms) {
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function reasonText(reason) {
  if (reason === "ttl_expired") return "房间已到期";
  if (reason === "empty") return "房间已空";
  if (reason === "manual") return "房间被手动销毁";
  return reason || "未知原因";
}

chatTab.hidden = true;
archiveTab.hidden = true;
