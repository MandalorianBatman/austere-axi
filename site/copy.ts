// Copy buttons next to install commands. The commands stay selectable without it.
document.addEventListener("click", (e) => {
  const btn = e.target instanceof Element ? e.target.closest<HTMLElement>("button[data-copy]") : null;
  if (!btn || !navigator.clipboard) return;
  navigator.clipboard.writeText(btn.dataset.copy ?? "").then(() => {
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = "Copy"), 1500);
  });
});
