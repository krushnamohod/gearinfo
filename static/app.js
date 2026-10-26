const $ = (id) => document.getElementById(id);

const fileInput = $("file");
const dropzone = $("dropzone");
const preview = $("preview");
const dropHint = $("dropHint");
const analyzeBtn = $("analyzeBtn");
const notes = $("notes");
const thread = $("thread");
const empty = $("empty");
const statusEl = $("status");
const copyBtn = $("copyBtn");
const askForm = $("askForm");
const question = $("question");
const askBtn = $("askBtn");

let selectedFile = null;
let sessionId = null;
let busy = false;
let reportMarkdown = "";

marked.setOptions({ gfm: true, breaks: false });

// Pull $...$ / $$...$$ out before Markdown parsing so underscores and
// asterisks inside formulas aren't turned into emphasis, then render with KaTeX.
function renderMath(text) {
  const formulas = [];
  const stash = (tex, display) => {
    let html;
    try {
      html = katex.renderToString(tex, { displayMode: display, throwOnError: false });
    } catch {
      html = `<code>${tex.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])}</code>`;
    }
    formulas.push(html);
    return `@@MATH${formulas.length - 1}@@`;
  };
  const masked = text
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => stash(tex, true))
    .replace(/\$([^\s$](?:[^$\n]*?[^\s$])?)\$/g, (_, tex) => stash(tex, false));
  return { masked, restore: (html) => html.replace(/@@MATH(\d+)@@/g, (_, i) => formulas[i]) };
}

function renderMarkdown(el, text) {
  const { masked, restore } = renderMath(text);
  el.innerHTML = restore(DOMPurify.sanitize(marked.parse(masked)));
  el.querySelectorAll("table").forEach((t) => {
    if (t.parentElement.classList.contains("table-wrap")) return;
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    t.replaceWith(wrap);
    wrap.appendChild(t);
  });
}

function setBusy(on, label = "") {
  busy = on;
  statusEl.textContent = label;
  statusEl.classList.toggle("busy", on);
  analyzeBtn.disabled = on || !selectedFile;
  askBtn.disabled = on;
}

function addMessage(kind, text) {
  const el = document.createElement("div");
  el.className = `msg ${kind}`;
  if (kind === "assistant") el.classList.add("md");
  el.textContent = text;
  thread.appendChild(el);
  return el;
}

function selectFile(file) {
  if (!file || !file.type.startsWith("image/")) return;
  selectedFile = file;
  preview.src = URL.createObjectURL(file);
  preview.hidden = false;
  dropHint.hidden = true;
  analyzeBtn.disabled = busy;
}

fileInput.addEventListener("change", () => selectFile(fileInput.files[0]));
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
});
["dragenter", "dragover"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("over"); }));
dropzone.addEventListener("drop", (e) => selectFile(e.dataTransfer.files[0]));
document.addEventListener("paste", (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
  if (item) selectFile(item.getAsFile());
});

// Reads the server's SSE stream from a fetch response and renders it live.
async function consumeStream(response, target, { onDone } = {}) {
  if (!response.ok) {
    let msg = `Request failed (${response.status})`;
    try { msg = (await response.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let pending = false;

  const flush = () => { pending = false; renderMarkdown(target, text); };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 2);
      if (!line.startsWith("data:")) continue;
      const event = JSON.parse(line.slice(5));
      if (event.type === "start") {
        sessionId = event.session_id;
        setBusy(true, "Writing…");
      } else if (event.type === "text") {
        text += event.text;
        if (!pending) { pending = true; requestAnimationFrame(flush); }
      } else if (event.type === "error") {
        throw new Error(event.message);
      } else if (event.type === "done") {
        flush();
        if (event.truncated) addMessage("note", "The answer hit the length limit and was cut off.");
        onDone?.(text, event);
      }
    }
  }
  return text;
}

analyzeBtn.addEventListener("click", async () => {
  if (!selectedFile || busy) return;
  thread.innerHTML = "";
  empty.hidden = true;
  askForm.hidden = true;
  copyBtn.hidden = true;
  sessionId = null;
  setBusy(true, "Analyzing image…");

  const form = new FormData();
  form.append("image", selectedFile);
  form.append("notes", notes.value);
  const target = addMessage("assistant", "");

  try {
    const res = await fetch("/api/analyze", { method: "POST", body: form });
    await consumeStream(res, target, {
      onDone: (text) => {
        reportMarkdown = text;
        askForm.hidden = false;
        copyBtn.hidden = false;
      },
    });
  } catch (err) {
    target.remove();
    addMessage("error", err.message);
  } finally {
    setBusy(false);
  }
});

async function ask(q) {
  if (!q || !sessionId || busy) return;
  question.value = "";
  addMessage("user", q);
  const target = addMessage("assistant", "");
  setBusy(true, "Thinking…");
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, question: q }),
    });
    await consumeStream(res, target);
  } catch (err) {
    target.remove();
    addMessage("error", err.message);
  } finally {
    setBusy(false);
  }
}

askForm.addEventListener("submit", (e) => { e.preventDefault(); ask(question.value.trim()); });
askForm.querySelectorAll(".chip").forEach((chip) =>
  chip.addEventListener("click", () => ask(chip.textContent)));

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(reportMarkdown);
    copyBtn.textContent = "Copied";
    setTimeout(() => (copyBtn.textContent = "Copy Markdown"), 1500);
  } catch {}
});
