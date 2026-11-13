// Runs OpenPGP.js off the page's main thread. See crypto.js.

importScripts("/assets/openpgp.min.js");

const ARMOR_HEADER = "-----BEGIN PGP MESSAGE-----";

/** Accepts both binary (`gpg -c`) and ASCII armored (`gpg -ac`) messages. */
function readMessage(data) {
  const head = new TextDecoder().decode(data.subarray(0, ARMOR_HEADER.length));
  if (head === ARMOR_HEADER) return openpgp.readMessage({armoredMessage: new TextDecoder().decode(data)});
  return openpgp.readMessage({binaryMessage: data});
}

self.addEventListener("message", async (event) => {
  const {id, op, bytes, filename, modified, passphrase} = event.data;
  try {
    let result;
    if (op === "encrypt") {
      const message = await openpgp.createMessage({
        binary: new Uint8Array(bytes),
        filename,
        date: new Date(modified),
        format: "binary",
      });
      // Binary output, not ASCII armor: smaller, and what `gpg -d` reads too.
      result = await openpgp.encrypt({message, passwords: [passphrase], format: "binary"});
    } else {
      const decrypted = await openpgp.decrypt({
        message: await readMessage(new Uint8Array(bytes)),
        passwords: [passphrase],
        format: "binary",
      });
      result = decrypted.data;
    }
    // Hand the result back without copying it when it owns its whole buffer.
    const whole = result.byteOffset === 0 && result.byteLength === result.buffer.byteLength;
    const buffer = whole ? result.buffer : result.slice().buffer;
    self.postMessage({id, ok: true, bytes: buffer}, [buffer]);
  } catch (error) {
    self.postMessage({id, ok: false, error: String((error && error.message) || error)});
  }
});
