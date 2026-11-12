// Landing page: drop, browse or paste a file, optionally encrypt it with
// OpenPGP in the browser, and upload it to this origin.

const config = JSON.parse(document.getElementById("transfr-config").textContent);

function promptPassphrase() {
  for (let trial = 0; trial < 3; trial++) {
    const passphrase = prompt("Enter passphrase to encrypt file with");
    if (passphrase === null) return null;
    if (passphrase.length >= 4) return passphrase;
    alert("Passphrase must be at least 4 characters long.");
  }
  alert("You can turn off encryption by clicking the 🔐 button.");
  return null;
}

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
  const ext = Array.from(clean(dot > 0 ? base.slice(dot + 1) : "")).slice(0, 16).join("");
  const build = () => stem.join("") + (ext ? "." + ext : "");
  while (stem.length > 1 &&
    (build().length > MAX_NAME_CHARS || encodeURIComponent(build()).length > MAX_ENCODED_NAME_CHARS)) {
    stem.pop();
  }
  return build();
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " bytes";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function tooLargeMessage() {
  return "File size limit exceeded. Max file size is " + config.maxFileSizeLabel + ".";
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
      else reject(new Error(text || "Upload failed (" + xhr.status + ")"));
    });
    xhr.addEventListener("error", () => reject(new Error("Network error, please try again.")));
    xhr.addEventListener("abort", () => reject(new Error("Upload cancelled.")));
    xhr.send(file);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const dropzoneEl = document.getElementById("dropzone");
  const dropzoneText = document.getElementById("dropzone-text");
  const dropzoneResult = document.getElementById("dropzone-result");
  const inputEl = document.getElementById("file-input");
  const encryptBtn = document.getElementById("encrypt-btn");
  const finalDropzoneText = "Drop or paste another file to transfr.";

  // Encryption is on by default; the choice is remembered per browser, where
  // the browser allows storage at all.
  let doEncrypt = encryptBtn.classList.contains("active");
  try {
    const stored = localStorage.getItem("doEncrypt");
    if (stored !== null) doEncrypt = stored === "1";
  } catch {}
  encryptBtn.classList.toggle("active", doEncrypt);

  encryptBtn.addEventListener("click", () => {
    doEncrypt = encryptBtn.classList.toggle("active");
    try {
      localStorage.setItem("doEncrypt", doEncrypt ? "1" : "0");
    } catch {}
  });
  dropzoneEl.addEventListener("click", (e) => {
    if (e.target && e.target.id !== "encrypt-btn") inputEl.click();
  });

  // Everything below the dropzone fades out while a file is being dragged
  // over the page, so the drop target is unmistakable.
  const siblings = Array.from(document.querySelectorAll("#dropzone ~ *"));
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

  function showResult(link, encrypted, decryptedName) {
    dropzoneResult.textContent = "";
    const anchor = document.createElement("a");
    anchor.href = link;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.textContent = link;
    dropzoneResult.append("Upload finished", document.createElement("br"), anchor,
      " (deletes in " + config.ttlLabel + ")");
    if (encrypted) {
      dropzoneResult.append(document.createElement("br"),
        "It can be decrypted with the passphrase you used to encrypt it:");
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = "curl -L " + link + " | gpg --pinentry-mode loopback -d -o " + decryptedName;
      pre.append(code);
      dropzoneResult.append(pre);
    }
    dropzoneResult.style.display = "unset";
  }

  function showError(message) {
    dropzoneResult.textContent = "";
    const span = document.createElement("span");
    span.style.color = "red";
    span.textContent = message;
    dropzoneResult.append(span);
    dropzoneResult.style.display = "unset";
  }

  /** Resolves to false when the user backed out before anything was sent. */
  async function upload(file) {
    const filename = safeFilename(file.name);
    const label = filename + " (" + formatBytes(file.size) + ")";
    let encrypted = false;
    // A renamed view of the same data: nothing is copied into memory.
    let upFile = new File([file], filename, {type: file.type || "application/octet-stream"});

    if (doEncrypt) {
      const passphrase = promptPassphrase();
      if (!passphrase) return false;
      dropzoneText.innerText = label + ": Encrypting...";
      const message = await openpgp.createMessage({
        binary: new Uint8Array(await file.arrayBuffer()),
        filename: filename,
        date: new Date(file.lastModified || Date.now()),
        format: "binary",
      });
      const ciphertext = await openpgp.encrypt({
        message,
        passwords: [passphrase], // multiple passwords possible later
        format: "binary", // don't ASCII armor (for Uint8Array output)
      });
      encrypted = true;
      upFile = new File([ciphertext], filename + ".pgp", {type: "application/pgp-encrypted"});
      // Encryption adds a little, so a file just under the limit can go over.
      if (upFile.size > config.maxFileSizeBytes) throw new Error(tooLargeMessage());
    }

    dropzoneText.innerText = label + ": Uploading...";
    const text = await put("/" + encodeURIComponent(upFile.name), upFile, (fraction) => {
      dropzoneText.innerText = label + ": Uploading... " + Math.floor(fraction * 100) + "%";
    });

    // Only ever link to a URL this origin produced.
    const link = new URL(text, location.origin);
    if (link.origin !== location.origin) throw new Error("Unexpected upload response: " + text);
    showResult(link.href, encrypted, filename);
    return true;
  }

  let busy = false;

  function handleFiles(files) {
    if (!files.length || busy) return;
    if (files.length > 1) {
      alert("Only one file can be uploaded at a time.");
      return;
    }
    const file = files[0];
    if (file.size > config.maxFileSizeBytes) {
      alert(tooLargeMessage());
      return;
    }
    const idleText = dropzoneText.innerText;
    busy = true;
    upload(file).then((sent) => {
      dropzoneText.innerText = sent ? finalDropzoneText : idleText;
    }).catch((e) => {
      console.error(e);
      showError("Error uploading file. " + (e && e.message ? e.message : "Please try again later."));
      dropzoneText.innerText = idleText;
    }).finally(() => {
      busy = false;
    });
  }

  document.body.addEventListener("dragover", (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault(); // required for the drop event to fire
    document.body.classList.add("drop-hover");
    dropzoneEl.classList.toggle("drop-hover", dropzoneEl.contains(e.target));
    setSiblingsVisible(false);
    // dragover keeps firing while a file is held over the page, so the drag
    // has ended (dropped, cancelled or left the window) once it stops.
    clearTimeout(dragTimer);
    dragTimer = setTimeout(endDrag, 200);
  });
  document.body.addEventListener("drop", (e) => {
    e.preventDefault(); // otherwise the browser navigates to the file
    endDrag();
    handleFiles(Array.from((e.dataTransfer && e.dataTransfer.files) || []));
  });

  inputEl.addEventListener("change", () => {
    const files = Array.from(inputEl.files || []);
    inputEl.value = ""; // so choosing the same file again fires change again
    handleFiles(files);
  });

  document.body.addEventListener("paste", (e) => {
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
    if (!doEncrypt &&
      !confirm("Are you sure you want to upload the file or text from the clipboard WITHOUT encryption?")) return;
    handleFiles([file]);
  });
});
