// A short first-visit walk through the things people miss: the timeline, the camera views,
// the findings, comparing, saving and the library. Shown once after the first flight loads; can be replayed.
const KEY = "dc.toured";

interface Step { sel: string; title: string; text: string; place: "above" | "below" | "left" }
const STEPS: Step[] = [
  { sel: ".transport", title: "The timeline drives everything", text: "Drag it, press Space to play, or use , and . to hop between events. The 3D view, charts and readout all follow it.", place: "above" },
  { sel: "#cam-modes, .cam-modes", title: "Change the view", text: "Follow chases the rocket, Overview shows the whole flight, Ground is the view from the pad. Earth drapes it on satellite terrain.", place: "below" },
  { sel: "#find-panel", title: "Start with the findings", text: "Things worth a look, each tied to a moment in the flight. Click one to jump there.", place: "left" },
  { sel: "#cmp-panel", title: "Compare it", text: "Add an OpenRocket sim, another flight or a second altimeter from the same rocket. You get a plain-words summary, Student Launch checks side by side, and, for two units in one rocket, how well they agree.", place: "left" },
  { sel: "#save-open", title: "Keep it", text: "Save the flight to this browser's library to reopen it, compare it with others or share it with the team.", place: "below" },
  { sel: "#lib-open", title: "Your library", text: "Saved flights with search, tags and trends per vehicle. Pin one as a vehicle's reference, refresh stored numbers after changing masses, and export a backup now and then.", place: "below" },
];

export function tourSeen(): boolean {
  try { return localStorage.getItem(KEY) === "1"; } catch { return true; }
}

export function startTour() {
  document.querySelector(".tour")?.remove();
  let i = 0;
  const box = document.createElement("div");
  box.className = "tour";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-live", "polite");
  document.body.appendChild(box);
  const done = () => {
    box.remove();
    document.querySelectorAll(".tour-target").forEach((x) => x.classList.remove("tour-target"));
    window.removeEventListener("resize", place);
    document.removeEventListener("keydown", onKey, true);
    try { localStorage.setItem(KEY, "1"); } catch { /* ignore */ }
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); done(); } };
  function target() {
    return [...document.querySelectorAll<HTMLElement>(STEPS[i].sel)].find((el) => !el.closest("[hidden]") && el.offsetParent !== null) ?? null;
  }
  function place() {
    const s = STEPS[i];
    const el = target();
    document.querySelectorAll(".tour-target").forEach((x) => x.classList.remove("tour-target"));
    if (!el) { if (i < STEPS.length - 1) { i++; render(); } else done(); return; }
    el.classList.add("tour-target");
    el.scrollIntoView({ block: "nearest", behavior: "auto" });
    const r = el.getBoundingClientRect();
    const w = Math.min(320, window.innerWidth - 24);
    box.style.width = `${w}px`;
    const bh = box.offsetHeight;
    let x = r.left + r.width / 2 - w / 2, y = r.bottom + 12;
    if (s.place === "above") y = r.top - bh - 12;
    if (s.place === "left" && r.left - w - 16 > 0) { x = r.left - w - 16; y = r.top + 8; }
    if (y + bh > window.innerHeight - 8) y = Math.max(8, r.top - bh - 12);
    if (y < 8) y = Math.min(window.innerHeight - bh - 8, r.bottom + 12);
    box.style.left = `${Math.max(12, Math.min(window.innerWidth - w - 12, x))}px`;
    box.style.top = `${y}px`;
  }
  function render() {
    const s = STEPS[i];
    box.innerHTML = `<div class="tour-step">${i + 1} of ${STEPS.length}</div><h3>${s.title}</h3><p>${s.text}</p>
      <div class="tour-actions"><button class="btn small-btn" data-tour="skip" type="button">${i === STEPS.length - 1 ? "Close" : "Skip tour"}</button>${
        i < STEPS.length - 1 ? '<button class="btn small-btn primary" data-tour="next" type="button">Next</button>' : '<button class="btn small-btn primary" data-tour="skip" type="button">Got it</button>'
      }</div>`;
    place();
    (box.querySelector('[data-tour="next"]') as HTMLElement | null ?? box.querySelector('[data-tour="skip"]') as HTMLElement)?.focus();
  }
  box.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>("[data-tour]")?.dataset.tour;
    if (a === "next") { i++; render(); } else if (a === "skip") done();
  });
  window.addEventListener("resize", place);
  document.addEventListener("keydown", onKey, true);
  render();
}
