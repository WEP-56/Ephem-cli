const IMAGE_MAX_BYTES = 1024 * 1024;
const IMAGE_MAX_EDGE = 1600;
const THUMB_MAX_EDGE = 360;
const SALT = "ephem-v1-room-salt";
const INFO = "ephem-room-encryption-key";

const $ = (id) => document.getElementById(id);

const connectView = $("connectView");
const chatView = $("chatView");
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
  sendBtn.disabled = true;
  try {
    await sendPlaintext(JSON.stringify({ v: 1, kind: "text", text }));
    addTextMessage(username, text, true);
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
  imageBtn.disabled = true;
  try {
    const image = await prepareImageMessage(file);
    await sendPlaintext(JSON.stringify(image));
    addImageMessage(username, image, true);
  } catch (err) {
    addSystem(`发送图片失败：${err instanceof Error ? err.message : String(err)}`, "error");
  } finally {
    imageBtn.disabled = false;
  }
});

function openSocket() {
  manuallyClosed = false;
  closing = false;
  setConnectionState("连接中", true);
  const url = `${wsBase()}/room/${encodeURIComponent(roomCode)}?username=${encodeURIComponent(username)}`;
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
    if (parsed.kind === "image") addImageMessage(payload.from ?? "未知", parsed, false);
    else addTextMessage(payload.from ?? "未知", parsed.text, false);
  } catch {
    addSystem(`收到来自 ${payload.from ?? "未知"} 的无法解密的消息`, "warn");
  }
}

async function sendPlaintext(plaintext) {
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("连接未就绪");
  const encrypted = await encryptMessage(plaintext);
  ws.send(JSON.stringify({ type: "message", payload: encrypted }));
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
  const mainBlob = await renderImage(bitmap, IMAGE_MAX_EDGE, "image/jpeg", 0.84);
  if (mainBlob.size > IMAGE_MAX_BYTES) throw new Error(`压缩后仍超过 ${formatBytes(IMAGE_MAX_BYTES)}`);
  const thumbBlob = await renderImage(bitmap, THUMB_MAX_EDGE, "image/jpeg", 0.76);
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

function addTextMessage(from, text, mine) {
  const bubble = messageBubble(from, mine);
  const body = document.createElement("div");
  body.className = "text";
  body.textContent = text;
  bubble.append(body, timeEl());
  messageList.append(bubble);
  scrollToBottom();
}

function addImageMessage(from, image, mine) {
  const bubble = messageBubble(from, mine);
  const img = document.createElement("img");
  img.className = "image-preview";
  img.alt = image.name || "image";
  img.src = imageToUrl(image.thumb || image);
  if (image.width && image.height) {
    img.width = Math.min(image.width, 420);
    img.height = Math.round((img.width / image.width) * image.height);
  }
  const meta = document.createElement("div");
  meta.className = "image-meta";
  meta.textContent = `${image.name ? `${image.name} · ` : ""}${formatBytes(image.size)} · ${image.mime}`;
  bubble.append(img, meta, timeEl());
  messageList.append(bubble);
  scrollToBottom();
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

function timeEl() {
  const el = document.createElement("div");
  el.className = "time";
  el.textContent = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  return el;
}

function showChat() {
  connectView.hidden = true;
  chatView.hidden = false;
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
  messageList.replaceChildren();
  chatView.hidden = true;
  connectView.hidden = false;
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
  const left = Math.max(0, joinedInfo.expiresAt - Date.now());
  roomMeta.textContent = `${joinedInfo.currentMembers}/${joinedInfo.maxMembers} 人 · 剩余 ${formatDuration(left)}`;
}

function setConnectionState(text, warn) {
  connState.textContent = text;
  connState.classList.toggle("warn", Boolean(warn));
}

function setConnectError(text) {
  connectError.textContent = text;
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
