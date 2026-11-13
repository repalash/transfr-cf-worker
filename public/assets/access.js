// File page: download an encrypted file and decrypt it in the browser.

const file = JSON.parse(document.getElementById("transfr-file").textContent);
const ARMOR_HEADER = "-----BEGIN PGP MESSAGE-----";

/** Accepts both binary (`gpg -c`) and ASCII armored (`gpg -ac`) messages. */
async function readMessage(bytes) {
  const head = new TextDecoder().decode(bytes.slice(0, ARMOR_HEADER.length));
  if (head === ARMOR_HEADER) {
    return openpgp.readMessage({armoredMessage: new TextDecoder().decode(bytes)});
  }
  return openpgp.readMessage({binaryMessage: bytes});
}

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

  let downloading = false;
  decryptLink.addEventListener("click", async (e) => {
    e.preventDefault();
    if (downloading) return;
    downloading = true;
    try {
      const passphrase = prompt("Enter passphrase to decrypt the file with");
      if (passphrase === null) return;
      resultText.innerText = "Downloading file...";
      const res = await fetch(file.rawUrl);
      if (!res.ok) throw new Error("Download failed: " + res.status);
      const encrypted = new Uint8Array(await res.arrayBuffer());
      resultText.innerText = "Decrypting file...";
      const decrypted = await openpgp.decrypt({
        message: await readMessage(encrypted),
        passwords: [passphrase],
        format: "binary",
      });
      saveFile(decrypted.data, file.decryptedName);
      resultText.innerText = "File downloaded.";
    } catch (err) {
      console.error(err);
      resultText.innerText = "Could not decrypt the file. Check the passphrase, " +
        "or download the raw file and decrypt it with gpg.";
    } finally {
      downloading = false;
    }
  });
});
