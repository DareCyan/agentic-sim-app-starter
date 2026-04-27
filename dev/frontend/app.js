/* Tab switching — hash-based routing */
function switchTab(tabName) {
  if (tabName !== "workflow") {
    wfStopRealTimer();
  }
  if (tabName === "app-build") {
    refreshAll();
  }
  if (tabName === "exception" && !excCache.loaded) {
    excLoadAll();
  }
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("is-active"));
  document.querySelectorAll(".tab-pane").forEach((p) => p.classList.remove("is-active"));
  document.querySelector(`.tab[data-tab="${tabName}"]`)?.classList.add("is-active");
  document.querySelector(`.tab-pane[data-pane="${tabName}"]`)?.classList.add("is-active");
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    location.hash = tab.dataset.tab;
  });
});

function applyTabFromHash() {
  const tab = location.hash.replace("#", "") || "workflow";
  if (document.querySelector(`.tab[data-tab="${tab}"]`)) {
    switchTab(tab);
  }
}

window.addEventListener("hashchange", applyTabFromHash);
applyTabFromHash();
