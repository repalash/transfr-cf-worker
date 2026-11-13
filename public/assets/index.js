// Landing page: drop, browse or paste a file, optionally encrypt it with
// OpenPGP in the browser, and upload it to this origin.

import {encrypt} from "/assets/crypto.js";
import {copyRow, copyText, formatBytes, showHideButton} from "/assets/ui.js";

const config = JSON.parse(document.getElementById("transfr-config").textContent);

const MIN_PASSPHRASE_LENGTH = 4;

// The server accepts names up to 256 characters and 960 once percent encoded.
// Stay well inside both, leaving room for the ".pgp" an encrypted upload adds.
const MAX_NAME_CHARS = 200;
const MAX_ENCODED_NAME_CHARS = 900;

/**
 * Strips directories and keeps letters and digits of any script, so the name
 * is safe in a URL and in a shell command without mangling non-English names.
 * A name too long for the server is shortened, keeping its extension.
 */
function safeFilename(name) {
  const base = name.normalize("NFC").split("/").pop().split("\\").pop();
  const dot = base.lastIndexOf(".");
  const clean = (part) => part.replace(/[^\p{L}\p{N}_]+/gu, "-");
  // Arrays of whole characters, so shortening never splits one in half.
  const stem = Array.from(clean(dot > 0 ? base.slice(0, dot) : base).replace(/^-+|-+$/g, "") || "file");
  const ext = Array.from(clean(dot > 0 ? base.slice(dot + 1) : "")).slice(0, 32).join("");
  const build = () => stem.join("") + (ext ? "." + ext : "");
  while (stem.length > 1 &&
    (build().length > MAX_NAME_CHARS || encodeURIComponent(build()).length > MAX_ENCODED_NAME_CHARS)) {
    stem.pop();
  }
  return build();
}

function tooLargeMessage() {
  return "That file is too large. The limit is " + config.maxFileSizeLabel + ".";
}

/** PUTs the file and resolves with the response text; reports progress as 0..1. */
function put(path, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", path);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    });
    xhr.addEventListener("load", () => {
      const text = (xhr.responseText || "").trim();
      if (xhr.status >= 200 && xhr.status < 300) resolve(text);
      else reject(new Error(text || "The upload failed (" + xhr.status + ")."));
    });
    xhr.addEventListener("error", () => reject(new Error("Network error. Check your connection and try again.")));
    xhr.addEventListener("abort", () => reject(new Error("The upload was cancelled.")));
    xhr.send(file);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const dropzoneEl = document.getElementById("dropzone");
  const inputEl = document.getElementById("file-input");
  const encryptBtn = document.getElementById("encrypt-btn");
  const statusEl = document.getElementById("status");
  const statusText = document.getElementById("status-text");
  const statusProgress = document.getElementById("status-progress");
  const resultEl = document.getElementById("result");

  // ------------------------------------------------- encryption on or off

  // Encryption is on by default; the choice is remembered per browser, where
  // the browser allows storage at all.
  let encryptByDefault = encryptBtn.classList.contains("active");
  try {
    const stored = localStorage.getItem("doEncrypt");
    if (stored !== null) encryptByDefault = stored === "1";
  } catch {}
  const showEncryptDefault = () => {
    encryptBtn.classList.toggle("active", encryptByDefault);
    encryptBtn.setAttribute("aria-pressed", String(encryptByDefault));
    encryptBtn.textContent = "End-to-end encryption " + (encryptByDefault ? "on" : "off");
  };
  showEncryptDefault();

  encryptBtn.addEventListener("click", () => {
    encryptByDefault = !encryptByDefault;
    showEncryptDefault();
    try {
      localStorage.setItem("doEncrypt", encryptByDefault ? "1" : "0");
    } catch {}
  });

  // --------------------------------------------------- status and result

  /** `fraction` is 0..1, or null while there is nothing to measure. */
  function showStatus(text, fraction) {
    statusText.textContent = text;
    if (fraction === null) statusProgress.removeAttribute("value");
    else statusProgress.value = fraction;
    statusEl.hidden = false;
  }

  function showError(message) {
    statusEl.hidden = true;
    resultEl.textContent = "";
    const text = document.createElement("p");
    text.className = "result-error";
    text.textContent = message;
    resultEl.append(text);
    resultEl.hidden = false;
  }

  function showResult(link, name, size, encrypted, decryptedName) {
    statusEl.hidden = true;
    resultEl.textContent = "";

    const title = document.createElement("p");
    title.className = "result-title";
    const ok = document.createElement("span");
    ok.className = "ok";
    ok.textContent = "✓ ";
    const meta = document.createElement("span");
    meta.className = "result-meta";
    meta.textContent = " · " + formatBytes(size) + (encrypted ? " · encrypted" : "") +
      " · deleted after " + config.ttlLabel;
    title.append(ok, "Uploaded " + name, meta);

    const linkRow = copyRow(link, "Copy link", "Link to the file");
    const note = document.createElement("p");
    note.className = "result-note";
    note.textContent = "Anyone with this link can download the file" +
      (encrypted ? ", and needs your passphrase to open it." : ".");
    resultEl.append(title, linkRow.row, note);

    if (encrypted) {
      const terminal = document.createElement("p");
      terminal.className = "result-note";
      terminal.textContent = "To download and decrypt it in a terminal:";
      const command = "curl -L " + link + " | gpg --pinentry-mode loopback -d -o " + decryptedName;
      resultEl.append(terminal, copyRow(command, "Copy", "Command to download and decrypt the file").row);
    }
    resultEl.hidden = false;

    // Most people want the link on their clipboard next. Browsers only allow
    // this without a click in some cases; the button is there for the rest.
    copyText(link).then((copied) => {
      if (!copied) return;
      linkRow.showCopied();
      note.textContent = "Link copied to your clipboard. " + note.textContent;
    });
  }

  // ------------------------------------------------------ the send dialog

  const dialog = document.getElementById("send-dialog");
  const dialogFile = document.getElementById("send-file");
  const dialogEncrypt = document.getElementById("send-encrypt");
  const dialogSecret = document.getElementById("send-secret");
  const dialogPassphrase = document.getElementById("send-passphrase");
  const dialogError = document.getElementById("send-error");
  const dialogPlainNote = document.getElementById("send-plain-note");
  const dialogSubmit = document.getElementById("send-submit");
  let answer = null;

  showHideButton(dialogPassphrase, document.getElementById("send-show"));

  function syncDialog() {
    const encrypting = dialogEncrypt.checked;
    dialogSecret.hidden = !encrypting;
    dialogPlainNote.hidden = encrypting;
    dialogError.hidden = true;
    dialogSubmit.textContent = encrypting ? "Encrypt and upload" : "Upload without encryption";
  }
  dialogEncrypt.addEventListener("change", () => {
    syncDialog();
    if (dialogEncrypt.checked) dialogPassphrase.focus();
  });
  // A complaint about the passphrase goes away once it is being changed.
  dialogPassphrase.addEventListener("input", () => { dialogError.hidden = true; });

  document.getElementById("send-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!dialogEncrypt.checked) return dialog.close("plain");
    if (dialogPassphrase.value.length < MIN_PASSPHRASE_LENGTH) {
      dialogError.textContent = "Use at least " + MIN_PASSPHRASE_LENGTH + " characters.";
      dialogError.hidden = false;
      dialogPassphrase.focus();
      return;
    }
    dialog.close("encrypt");
  });
  document.getElementById("send-cancel").addEventListener("click", () => dialog.close("cancel"));
  dialog.addEventListener("close", () => {
    const passphrase = dialogPassphrase.value;
    dialogPassphrase.value = "";
    if (!answer) return;
    // Escape closes the dialog with no return value: that is a cancel too.
    if (dialog.returnValue === "encrypt") answer({passphrase});
    else if (dialog.returnValue === "plain") answer({passphrase: null});
    else answer(null);
    answer = null;
  });

  /** Asks how to send the file. Resolves to {passphrase} (null for no encryption), or null if cancelled. */
  function askHowToSend(file, encryptChecked) {
    dialogFile.textContent = safeFilename(file.name) + " · " + formatBytes(file.size);
    dialogEncrypt.checked = encryptChecked;
    dialogPassphrase.type = "password";
    document.getElementById("send-show").textContent = "Show";
    syncDialog();
    dialog.returnValue = "";
    dialog.showModal();
    if (encryptChecked) dialogPassphrase.focus();
    return new Promise((resolve) => { answer = resolve; });
  }

  // ----------------------------------------------------------- uploading

  async function upload(file, passphrase) {
    const filename = safeFilename(file.name);
    const label = filename + " (" + formatBytes(file.size) + ")";
    // A renamed view of the same data: nothing is copied into memory.
    let upFile = new File([file], filename, {type: file.type || "application/octet-stream"});

    if (passphrase !== null) {
      showStatus("Encrypting " + label + "…", null);
      const ciphertext = await encrypt(await file.arrayBuffer(), filename, file.lastModified || Date.now(), passphrase);
      upFile = new File([ciphertext], filename + ".pgp", {type: "application/pgp-encrypted"});
      // Encryption adds a little, so a file just under the limit can go over.
      if (upFile.size > config.maxFileSizeBytes) throw new Error(tooLargeMessage());
    }

    showStatus("Uploading " + label + "…", 0);
    const text = await put("/" + encodeURIComponent(upFile.name), upFile, (fraction) => {
      showStatus("Uploading " + label + "… " + Math.floor(fraction * 100) + "%", fraction);
    });

    // Only ever link to a URL this origin produced.
    const link = new URL(text, location.origin);
    if (link.origin !== location.origin) throw new Error("Unexpected reply from the server: " + text);
    showResult(link.href, upFile.name, upFile.size, passphrase !== null, filename);
  }

  let busy = false;

  /** `alwaysAsk`: show the dialog even when encryption is off, as for pasted content. */
  async function handleFiles(files, alwaysAsk) {
    if (!files.length) return;
    if (busy) return showError("One upload at a time: wait for the current one to finish.");
    if (files.length > 1) return showError("Only one file can be uploaded at a time. To send several, zip them first.");
    const file = files[0];
    if (file.size > config.maxFileSizeBytes) return showError(tooLargeMessage());

    busy = true;
    try {
      let passphrase = null;
      if (encryptByDefault || alwaysAsk) {
        const choice = await askHowToSend(file, encryptByDefault);
        if (!choice) return;
        passphrase = choice.passphrase;
      }
      resultEl.hidden = true;
      await upload(file, passphrase);
    } catch (e) {
      console.error(e);
      showError("The upload did not work. " + (e && e.message ? e.message : "Please try again."));
    } finally {
      busy = false;
    }
  }

  // ------------------------------------------- drop, browse and paste

  dropzoneEl.addEventListener("click", () => inputEl.click());
  dropzoneEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    inputEl.click();
  });

  // Everything below the dropzone fades out while a file is being dragged
  // over the page, so the drop target is unmistakable.
  const siblings = Array.from(document.querySelectorAll("#dropzone ~ *:not(dialog)"));
  let siblingsHidden = false;

  function setSiblingsVisible(visible) {
    if (siblingsHidden === !visible) return;
    siblingsHidden = !visible;
    for (const el of siblings) {
      el.style.transition = "opacity 0.1s ease-out";
      el.style.opacity = visible ? "" : "0";
    }
  }

  let dragTimer = null;

  function endDrag() {
    clearTimeout(dragTimer);
    document.body.classList.remove("drop-hover");
    dropzoneEl.classList.remove("drop-hover");
    setSiblingsVisible(true);
  }

  document.body.addEventListener("dragover", (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault(); // required for the drop event to fire
    document.body.classList.add("drop-hover");
    dropzoneEl.classList.toggle("drop-hover", dropzoneEl.contains(e.target));
    setSiblingsVisible(false);
    // dragover keeps firing while a file is held over the page, so the drag
    // has ended (dropped, cancelled or left the window) once it stops. Browsers
    // may leave up to about half a second between two of these events.
    clearTimeout(dragTimer);
    dragTimer = setTimeout(endDrag, 700);
  });
  document.body.addEventListener("drop", (e) => {
    e.preventDefault(); // otherwise the browser navigates to the file
    endDrag();
    const items = Array.from((e.dataTransfer && e.dataTransfer.items) || []);
    const isFolder = (item) => {
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      return !!entry && entry.isDirectory;
    };
    if (items.some(isFolder)) return showError("Folders can't be uploaded. Zip the folder and upload the zip.");
    handleFiles(Array.from((e.dataTransfer && e.dataTransfer.files) || []), false);
  });

  inputEl.addEventListener("change", () => {
    const files = Array.from(inputEl.files || []);
    inputEl.value = ""; // so choosing the same file again fires change again
    handleFiles(files, false);
  });

  document.body.addEventListener("paste", (e) => {
    // Typing a passphrase is not an upload.
    if (dialog.open) return;
    // The event's data is only readable while the event is being dispatched,
    // so it is read here, before anything asynchronous.
    const data = e.clipboardData;
    if (!data) return;
    let file = data.files && data.files[0];
    if (!file) {
      const text = data.getData("text/plain");
      if (text) file = new File([text], "pasted.txt", {type: "text/plain"});
    }
    if (!file) return;
    e.preventDefault();
    // Pasting is easy to do by accident, so it always asks first.
    handleFiles([file], true);
  });
});
