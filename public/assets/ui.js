// Small helpers shared by the two pages.

export function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " bytes";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/** Copies text to the clipboard. Resolves to whether it worked: browsers may refuse without a click. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * A read-only field holding `text` with a button that copies it. Clicking the
 * field selects all of it, so it can also be copied by hand.
 */
export function copyRow(text, buttonLabel, fieldLabel) {
  const row = document.createElement("div");
  row.className = "copy-row";

  const field = document.createElement("input");
  field.type = "text";
  field.readOnly = true;
  field.value = text;
  field.setAttribute("aria-label", fieldLabel);
  field.addEventListener("focus", () => field.select());

  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn";
  button.textContent = buttonLabel;
  let reset = null;
  const showCopied = () => {
    button.textContent = "Copied";
    clearTimeout(reset);
    reset = setTimeout(() => { button.textContent = buttonLabel; }, 2000);
  };
  button.addEventListener("click", async () => {
    if (await copyText(text)) return showCopied();
    // No clipboard access: select the text so one key press copies it.
    field.focus();
    field.select();
  });

  row.append(field, button);
  return {row, field, button, showCopied};
}

/**
 * Wires up a passphrase field's Show/Hide button.
 */
export function showHideButton(input, button) {
  button.addEventListener("click", () => {
    const reveal = input.type === "password";
    input.type = reveal ? "text" : "password";
    button.textContent = reveal ? "Hide" : "Show";
    input.focus();
  });
}
