// Site-hosted approval dialog for the wallet owner. It lists exactly what the
// site requested; the owner may approve any subset. Resolves to the approved
// capability list, or null when denied.
export function askConsent({ title, origin, capabilities, expiresInMs }) {
  const dialog = document.createElement("dialog");
  dialog.id = "consent-dialog";
  dialog.setAttribute("aria-label", title);
  const heading = document.createElement("h2");
  heading.textContent = title;
  const note = document.createElement("p");
  note.textContent = `${origin} requests these capabilities. Approve only what you want to grant.`;
  const form = document.createElement("form");
  form.method = "dialog";
  for (const capability of capabilities) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.name = "capability";
    box.value = capability;
    box.checked = true;
    label.append(box, ` ${capability}`);
    form.append(label, document.createElement("br"));
  }
  const approve = document.createElement("button");
  approve.type = "button";
  approve.id = "consent-approve";
  approve.textContent = "Approve selected";
  const deny = document.createElement("button");
  deny.type = "button";
  deny.id = "consent-deny";
  deny.textContent = "Deny";
  form.append(approve, deny);
  dialog.append(heading, note, form);
  document.body.append(dialog);
  dialog.showModal();
  return new Promise((resolve) => {
    const finish = (value) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    approve.addEventListener("click", () =>
      finish(
        [...form.querySelectorAll("input:checked")].map((box) => box.value),
      ),
    );
    deny.addEventListener("click", () => finish(null));
    setTimeout(() => finish(null), expiresInMs);
  });
}
