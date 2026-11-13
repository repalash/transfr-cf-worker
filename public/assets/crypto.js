// OpenPGP encryption and decryption, run in a worker so that a large file
// does not freeze the page while it is processed. OpenPGP.js itself is only
// loaded, by the worker, the first time it is needed.

let worker = null;
let nextId = 1;
const pending = new Map();

function failAll(message) {
  for (const {reject} of pending.values()) reject(new Error(message));
  pending.clear();
  if (worker) worker.terminate();
  worker = null;
}

function call(message, transfer) {
  if (!worker) {
    worker = new Worker("/assets/crypto-worker.js");
    worker.addEventListener("message", (event) => {
      const {id, ok, bytes, error} = event.data;
      const waiting = pending.get(id);
      if (!waiting) return;
      pending.delete(id);
      if (ok) waiting.resolve(new Uint8Array(bytes));
      else waiting.reject(new Error(error));
    });
    worker.addEventListener("error", () => failAll("The encryption code could not be loaded."));
  }
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, {resolve, reject});
    worker.postMessage({...message, id}, transfer);
  });
}

/** Encrypts an ArrayBuffer with a passphrase. The buffer is handed over to the worker, not copied. */
export function encrypt(bytes, filename, modified, passphrase) {
  return call({op: "encrypt", bytes, filename, modified, passphrase}, [bytes]);
}

/** Decrypts an ArrayBuffer holding a binary or ASCII armored OpenPGP message. */
export function decrypt(bytes, passphrase) {
  return call({op: "decrypt", bytes, passphrase}, [bytes]);
}
