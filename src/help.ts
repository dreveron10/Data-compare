// A short "?" note on each panel: what it shows, where the numbers come from and their limits.
const HELP: Record<string, string> = {
  "video-panel": "Plays your own flight video in step with the replay. Pause on the frame where the rocket leaves the rail and press the liftoff button once; after that the timeline drives the video. The video never leaves your computer.",
  "sl-panel": "The Student Launch requirements this flight's data can answer, pass or fail. Limits come from recent handbooks and the Recovery check settings, so confirm them against this year's handbook. KE needs real section masses.",
  "find-panel": "Things worth a look, found automatically: pressure spikes, early or late pyro fires, large tilt or roll, battery dips, hard shocks and data problems. They are rules of thumb, not verdicts. Click one to jump there.",
  "veh-panel": "The rocket's numbers that the flight log can't tell you: masses, diameter, rated impulse and rail travel. Coast drag, Motor, rail exit and the Student Launch checks all use them, kept per vehicle name.",
  "rec-panel": "Landing kinetic energy of each section, descent time and drift against the limits you set. Landing speed is the main descent rate from the baro. Enter each independently landing section's mass.",
  "desc-panel": "Descent rates under drogue and main, corrected to sea level, and the parachute CdA they imply. With GPS: the wind at each altitude from the drift, a landing what-if, and chute sizing for target rates.",
  "motor-panel": "Thrust from the accelerometer: mass times axial acceleration plus drag. Accuracy follows the masses in the Vehicle card. Also rail exit speed (integrated from first motion) and liftoff thrust-to-weight.",
  "coast-panel": "Drag coefficient during coast, where the accelerometer reads drag directly. Uses the vertical speed and tilt, not the drifting inertial sideways speed, and stops at any pyro fire before apogee.",
  "cmp-panel": "Overlay up to three OpenRocket sims, other Blue Raven flights or other altimeters' CSVs. Line them up at liftoff, apogee or main, shift by hand, and read the plain-words summary and the sim match hints.",
  "gps-panel": "The Featherweight GPS against the Blue Raven after matching clocks and rotating the track onto true north. The landing card gives coordinates, map links and a GPX file for the recovery walk.",
  "marks-panel": "Your own notes pinned to moments in the flight. Press N anywhere to add one at the current time. They are saved with the flight and go into the report and exports.",
  "settings-panel": "The deploy settings workbook in plain words, with the logged state of each condition just before each fire (green met, red not met), and a check for risky setups like backups that fire first.",
};

export function initHelp() {
  for (const [id, text] of Object.entries(HELP)) {
    const panel = document.getElementById(id);
    const h = panel?.querySelector("h2");
    if (!panel || !h || panel.querySelector(".help-btn")) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "help-btn";
    btn.textContent = "?";
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-label", `About ${h.textContent}`);
    const p = document.createElement("p");
    p.className = "panel-help";
    p.hidden = true;
    p.id = `${id}-help`;
    p.textContent = text;
    btn.setAttribute("aria-controls", p.id);
    btn.addEventListener("click", () => {
      p.hidden = !p.hidden;
      btn.setAttribute("aria-expanded", String(!p.hidden));
    });
    h.appendChild(btn);
    h.after(p);
  }
}
