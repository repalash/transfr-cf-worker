// File page: download an encrypted file and decrypt it in the browser.

import {decrypt} from "/assets/crypto.js";
import {showHideButton} from "/assets/ui.js";

const file = JSON.parse(document.getElementById("transfr-file").textContent);

function saveFile(data, name) {
  const url = URL.createObjectURL(new File([data], name, {type: "application/octet-stream"}));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

document.addEventListener("DOMContentLoaded", () => {
  const resultText = document.getElementById("result_text");
  const decryptLink = document.querySelector(".main-link-enc");
  if (!file.encrypted || !decryptLink) return;

  const dialog = document.getElementById("open-dialog");
  const passphraseInput = document.getElementById("open-passphrase");
  let answer = null;

  const showButton = document.getElementById("open-show");
  showHideButton(passphraseInput, showButton);
  document.getElementById("open-form").addEventListener("submit", (e) => {
    e.preventDefault();
    dialog.close("open");
  });
  document.getElementById("open-cancel").addEventListener("click", () => dialog.close("cancel"));
  dialog.addEventListener("close", () => {
    const passphrase = passphraseInput.value;
    passphraseInput.value = "";
    if (!answer) return;
    answer(dialog.returnValue === "open" ? passphrase : null);
    answer = null;
  });

  /** Resolves to the passphrase, or null if the dialog was cancelled. */
  function askPassphrase() {
    passphraseInput.type = "password";
    showButton.textContent = "Show";
    dialog.returnValue = "";
    dialog.showModal();
    passphraseInput.focus();
    return new Promise((resolve) => { answer = resolve; });
  }

  let working = false;
  decryptLink.addEventListener("click", async (e) => {
    e.preventDefault();
    if (working) return;
    working = true;
    try {
      const passphrase = await askPassphrase();
      if (passphrase === null) return;
      resultText.textContent = "Downloading the file…";
      const res = await fetch(file.rawUrl);
      if (!res.ok) throw new Error("Download failed: " + res.status);
      const encrypted = await res.arrayBuffer();
      resultText.textContent = "Decrypting the file…";
      saveFile(await decrypt(encrypted, passphrase), file.decryptedName);
      resultText.textContent = "Decrypted. The file has been saved to your downloads.";
    } catch (err) {
      console.error(err);
      resultText.textContent = "Could not decrypt the file. Check the passphrase and try again, " +
        "or download the raw file and decrypt it with gpg.";
    } finally {
      working = false;
    }
  });
});
