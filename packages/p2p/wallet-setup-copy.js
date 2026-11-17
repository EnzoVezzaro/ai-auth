// Pure markup for the inline wallet setup shown on a site request screen. Kept
// in the SDK so it can be tested without a DOM; the wallet page supplies the
// error text and owns the form handler and the new key.
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );

/**
 * The no-wallet branch of a site request. Creating the wallet here keeps the
 * visitor on the same request; no action sends them to a separate identity
 * page. The new key stays in the wallet origin's storage.
 */
export function inlineCreateWalletForm({ error = "" } = {}) {
  return `<section class="panel"><div class="panel-head"><div><p class="mini-label">CREATE WALLET</p><h2>Create wallet to continue</h2><p class="panel-copy">Your wallet key is created and kept in this browser. Nothing is shared with the site except the approval you sign next.</p></div><span class="status-tag pending">LOCAL KEY</span></div>
    <form id="create-wallet-form">
      <div class="field"><label for="wallet-name">Agent name</label><input class="control" id="wallet-name" name="name" maxlength="60" autocomplete="off" required placeholder="E.g. Research assistant" /></div>
      <div class="field"><label for="wallet-passphrase">Recovery passphrase</label><input class="control" id="wallet-passphrase" name="passphrase" type="password" minlength="12" autocomplete="new-password" required /><small>Use 12 or more characters. The wallet derives an encryption key locally.</small></div>
      <div class="field"><label for="wallet-passphrase-confirm">Confirm passphrase</label><input class="control" id="wallet-passphrase-confirm" name="confirmation" type="password" minlength="12" autocomplete="new-password" required /></div>
      <p class="error-text" id="form-error" role="alert">${esc(error)}</p>
      <div class="callout"><strong>Recovery matters.</strong> If browser data is cleared, the encrypted recovery file is the only way to restore this key.</div>
      <div class="button-row"><button class="button" type="submit">Create wallet</button></div>
    </form>
  </section>`;
}
