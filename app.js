const STORAGE_HISTORY_KEY = "aria_chat_history";
const STORAGE_LANG_KEY = "aria_selected_language";

const messagesEl = document.getElementById("messages");
const textInput = document.getElementById("text-input");
const sendBtn = document.getElementById("send-btn");
const settingsBtn = document.getElementById("settings-btn");
const statusText = document.getElementById("status-text");

const settingsModal = document.getElementById("settings-modal");
const closeSettingsBtn = document.getElementById("close-settings-btn");
const deleteChatsBtn = document.getElementById("delete-chats-btn");
const langOptionButtons = document.querySelectorAll("#settings-lang-options .modal-option");

let messages = [];
let currentLang = "es-ES";
let isProcessing = false;

function init() {
  currentLang = localStorage.getItem(STORAGE_LANG_KEY) || "es-ES";
  loadHistory();

  settingsBtn.addEventListener("click", openSettings);
  closeSettingsBtn.addEventListener("click", closeSettings);
  settingsModal.addEventListener("click", (e) => {
    if (e.target === settingsModal) closeSettings();
  });

  deleteChatsBtn.addEventListener("click", () => {
    if (confirm("¿Seguro que quieres borrar todo el chat guardado? Esta acción no se puede deshacer.")) {
      localStorage.removeItem(STORAGE_HISTORY_KEY);
      messages = [];
      messagesEl.innerHTML = "";
      loadHistory();
      closeSettings();
    }
  });

  langOptionButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      currentLang = btn.dataset.lang;
      localStorage.setItem(STORAGE_LANG_KEY, currentLang);
      highlightActiveOptions();
    });
  });

  sendBtn.addEventListener("click", (e) => {
    e.preventDefault();
    sendMessage();
  });

  textInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
}

function openSettings() {
  highlightActiveOptions();
  settingsModal.classList.remove("hidden");
}

function closeSettings() {
  settingsModal.classList.add("hidden");
}

function highlightActiveOptions() {
  langOptionButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.lang === currentLang);
  });
}

function loadHistory() {
  const raw = localStorage.getItem(STORAGE_HISTORY_KEY);
  messages = raw ? JSON.parse(raw) : [];
  messagesEl.innerHTML = "";
  if (messages.length === 0) {
    addMessage("aria", "Sistemas en línea. Soy ARIA. Dígame qué necesita, señor.", false);
  } else {
    messages.forEach((m) => renderBubble(m.sender, m.text, m.failed));
    scrollToBottom();
  }
}

function saveHistory() {
  localStorage.setItem(STORAGE_HISTORY_KEY, JSON.stringify(messages));
}

async function sendMessage(textToSend = null) {
  let text = textToSend || textInput.value.trim();
  if (!text) {
    await new Promise(resolve => setTimeout(resolve, 100));
    text = textInput.value.trim();
  }

  if (!text) {
    addMessage("aria", "Escribe algo primero.", false);
    toggleInputState(false);
    isProcessing = false;
    return;
  }

  if (isProcessing) return;

  isProcessing = true;
  toggleInputState(true);

  if (!textToSend) {
    addMessage("user", text, true);
    textInput.value = "";
  }

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: messages.map((m) => ({
          role: m.sender === "user" ? "user" : "assistant",
          content: m.text,
        })),
        language: currentLang,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || "Error del servidor");
    }

    const data = await response.json();

    const parts = data.reply
      .split(/\|{2,}/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    for (const part of parts) {
      await simulateHumanTyping(part);
      addMessage("aria", part, true);
    }

    const lastMsg = messages.findLast(m => m.sender === 'user' && m.failed);
    if (lastMsg) {
      lastMsg.failed = false;
      saveHistory();
      renderAllBubbles();
    }

  } catch (err) {
    console.error("Error en sendMessage:", err);
    addMessage("aria", "Error al enviar. Inténtalo de nuevo.", true);
    const lastUserMsg = messages.filter(m => m.sender === 'user').pop();
    if (lastUserMsg) {
      lastUserMsg.failed = true;
      saveHistory();
      renderAllBubbles();
    }
  } finally {
    isProcessing = false;
    toggleInputState(false);
  }
}

function toggleInputState(loading) {
  textInput.disabled = loading;
  sendBtn.disabled = loading;
  if (loading) {
    sendBtn.classList.add("loading");
    sendBtn.innerHTML = `<span class="send-loading-dot"></span><span class="send-loading-dot"></span><span class="send-loading-dot"></span>`;
    statusText.innerHTML = `<span class="status-dot"></span> escribiendo…`;
  } else {
    sendBtn.classList.remove("loading");
    sendBtn.textContent = "➤";
    statusText.innerHTML = `<span class="status-dot"></span> en línea`;
    textInput.focus();
  }
}

async function simulateHumanTyping(text) {
  showTyping();
  const readPause = 400 + Math.random() * 800;
  const perCharMs = 60 + Math.random() * 80;
  let typingTime = text.length * perCharMs;
  if (text.length > 100) typingTime += 1000 + Math.random() * 1000;
  typingTime = Math.min(Math.max(typingTime, 500), 6000);
  await new Promise((r) => setTimeout(r, readPause + typingTime));
  hideTyping();
}

function addMessage(sender, text, persist, failed = false) {
  if (persist) {
    messages.push({ sender, text, failed });
    saveHistory();
  }
  renderBubble(sender, text, failed);
  scrollToBottom();
}

function renderAllBubbles() {
  messagesEl.innerHTML = "";
  messages.forEach((m) => renderBubble(m.sender, m.text, m.failed));
  scrollToBottom();
}

function renderBubble(sender, text, failed = false) {
  const row = document.createElement("div");
  row.className = `bubble-row ${sender}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  const time = document.createElement("span");
  time.className = "bubble-time";
  time.textContent = new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  bubble.appendChild(time);
  row.appendChild(bubble);
  if (failed && sender === "user") {
    const retryBtn = document.createElement("button");
    retryBtn.className = "retry-btn";
    retryBtn.innerHTML = "↻";
    retryBtn.title = "Reintentar";
    retryBtn.addEventListener("click", () => {
      const failedMsg = messages.find(m => m.sender === 'user' && m.text === text && m.failed);
      if (failedMsg) {
        const index = messages.indexOf(failedMsg);
        if (index > -1) {
          messages.splice(index, 1);
          saveHistory();
          renderAllBubbles();
        }
        sendMessage(text);
      }
    });
    row.appendChild(retryBtn);
  }
  messagesEl.appendChild(row);
}

function showTyping() {
  const row = document.createElement("div");
  row.className = "bubble-row aria";
  row.id = "typing-row";
  row.innerHTML = `<div class="typing-bubble"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></div>`;
  messagesEl.appendChild(row);
  scrollToBottom();
}

function hideTyping() {
  const row = document.getElementById("typing-row");
  if (row) row.remove();
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

init();
