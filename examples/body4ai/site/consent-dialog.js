// The only approval dialog for the site's connection. It lists exactly what
// BODY4AI requested; the visitor may allow any subset. Resolves to
// { approved: [capability...] } when at least one permission is allowed, or to
// { reason: "denied" | "timeout" } when nothing is allowed. Escape counts as
// "denied" and closes the dialog.
import {
  APPROVE_LABEL,
  DENY_LABEL,
  INTRO_TEXT,
  capabilityLabel,
} from "./messages.js";

export function askConsent({ title, capabilities, expiresInMs }) {
  const dialog = document.createElement("dialog");
  dialog.id = "consent-dialog";
  dialog.setAttribute("aria-labelledby", "consent-title");
  dialog.setAttribute("aria-describedby", "consent-intro");
  const heading = document.createElement("h2");
  heading.id = "consent-title";
  heading.textContent = title;
  const intro = document.createElement("p");
  intro.id = "consent-intro";
  intro.textContent = INTRO_TEXT;
  const choices = document.createElement("div");
  choices.className = "consent-choices";
  const boxes = capabilities.map((capability) => {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.name = "capability";
    box.value = capability;
    box.checked = true;
    label.append(box, ` ${capabilityLabel(capability)}`);
    choices.append(label);
    return box;
  });
  const actions = document.createElement("div");
  actions.className = "consent-actions";
  const approve = document.createElement("button");
  approve.type = "button";
  approve.id = "consent-approve";
  approve.textContent = APPROVE_LABEL;
  const deny = document.createElement("button");
  deny.type = "button";
  deny.id = "consent-deny";
  deny.className = "secondary";
  deny.textContent = DENY_LABEL;
  actions.append(approve, deny);
  dialog.append(heading, intro, choices, actions);
  document.body.append(dialog);

  const syncApprove = () => {
    approve.disabled = !boxes.some((box) => box.checked);
  };
  for (const box of boxes) box.addEventListener("change", syncApprove);
  syncApprove();

  dialog.showModal();
  return new Promise((resolve) => {
    let timer = null;
    const finish = (outcome) => {
      clearTimeout(timer);
      dialog.close();
      dialog.remove();
      resolve(outcome);
    };
    approve.addEventListener("click", () => {
      const approved = boxes
        .filter((box) => box.checked)
        .map((box) => box.value);
      finish(approved.length ? { approved } : { reason: "denied" });
    });
    deny.addEventListener("click", () => finish({ reason: "denied" }));
    // Escape fires "cancel"; handle it so the connect flow ends at once.
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish({ reason: "denied" });
    });
    timer = setTimeout(() => finish({ reason: "timeout" }), expiresInMs);
  });
}
