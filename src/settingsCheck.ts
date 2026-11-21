// Pre-flight style review of the Blue Raven deployment settings: things that are legal to set but
// often not what was meant. Reads only the settings, so it works the same before or after a flight.
import { CHANNELS, type Channel, type DeploySettings } from "./parsers/blueRaven";

export interface SettingIssue {
  level: "warn" | "info";
  channel?: Channel;
  title: string;
  detail: string;
}

const on = (s: DeploySettings, cond: string, ch: Channel) => !!s.conditions.find((c) => c.name.startsWith(cond))?.enabled[ch];
const val = (s: DeploySettings, k: string, ch: Channel) => s.values[k]?.[ch];
const opt = (s: DeploySettings, k: string, ch: Channel) => s.options[k]?.[ch] === "TRUE";

/** a channel counts as in use when it is armed by default or has any altitude/velocity/apogee gate */
function used(s: DeploySettings, ch: Channel) {
  return opt(s, "Arm_by_default", ch) || ["Alt_above_pad_<", "Apogee", "Total_Velocity_<", "Pressure_Increasing"].some((c) => on(s, c, ch));
}

export function checkSettings(s: DeploySettings): SettingIssue[] {
  const out: SettingIssue[] = [];
  const delayOf = (ch: Channel) => (opt(s, "Use_Delay", ch) ? val(s, "delay", ch) ?? 0 : 0);
  // groups: "main-style" channels wait for an altitude on the way down; the rest are apogee-style
  const mainLike = (ch: Channel) => on(s, "Alt_above_pad_<", ch);
  const descending = (ch: Channel) => on(s, "Apogee", ch) || on(s, "Pressure_Increasing", ch) || on(s, "Baro_velocity_<", ch);

  for (const ch of CHANNELS) {
    if (!used(s, ch)) continue;
    // 1) can fire while still climbing
    if (!descending(ch)) {
      const gates = [
        on(s, "Total_Velocity_<", ch) ? `velocity under ${val(s, "VEL1", ch)} ft/s` : "",
        on(s, "Total_Velocity_>", ch) ? `over ${val(s, "VEL2", ch)} ft/s` : "",
        on(s, "Alt_above_pad_>", ch) ? `above ${val(s, "AGL2", ch)} ft` : "",
        on(s, "Normal_Ascent", ch) ? "normal ascent" : "",
      ].filter(Boolean);
      out.push({
        level: "warn", channel: ch,
        title: `${ch} can fire before apogee`,
        detail: `${ch} has no Apogee, Pressure increasing or baro-velocity condition, so it can fire on the way up${gates.length ? ` (it only waits for ${gates.join(", ")})` : ""}. Fine for an airbrake or staging event; for a parachute add Apogee or Pressure increasing.`,
      });
    }
    // 3) not armed by default
    if (!opt(s, "Arm_by_default", ch) && (descending(ch) || mainLike(ch) || on(s, "Total_Velocity_<", ch))) {
      out.push({ level: "info", channel: ch, title: `${ch} is not armed by default`, detail: `${ch} only fires if it is armed before flight (by the app or a switch). Make sure that is on the checklist.` });
    }
  }

  // 2) altitude-triggered channels set very low (grouped when several share the same setting)
  const lowByAgl = new Map<number, Channel[]>();
  for (const ch of CHANNELS) {
    const agl = val(s, "AGL1", ch);
    if (used(s, ch) && mainLike(ch) && agl !== undefined && agl < 300) lowByAgl.set(agl, [...(lowByAgl.get(agl) ?? []), ch]);
  }
  for (const [agl, chs] of lowByAgl) {
    const names = chs.length === 1 ? chs[0] : `${chs.slice(0, -1).join(", ")} and ${chs[chs.length - 1]}`;
    out.push({
      level: "warn", channel: chs[0],
      title: `${names} set to fire at ${agl} ft`,
      detail: `${names} ${chs.length === 1 ? "waits" : "wait"} for altitude below ${agl} ft. At drogue speed (around 100 ft/s) that leaves about ${(agl / 100).toFixed(1)} s for a parachute to open. Most mains are set between 500 and 1000 ft.`,
    });
  }

  // 4) backups that fire before their primary
  const drogueGroup = CHANNELS.filter((ch) => used(s, ch) && !mainLike(ch) && descending(ch));
  const mainGroup = CHANNELS.filter((ch) => used(s, ch) && mainLike(ch) && descending(ch));
  if (drogueGroup.includes("Apo")) {
    for (const b of drogueGroup.filter((c) => c !== "Apo")) {
      if (delayOf(b) < delayOf("Apo")) {
        out.push({
          level: "warn", channel: b,
          title: `Backup ${b} fires before Apo`,
          detail: `${b} has ${delayOf(b) ? `a ${delayOf(b)} s` : "no"} delay while Apo waits ${delayOf("Apo")} s, so the backup charge goes first. Give the backup a longer delay than the primary${opt(s, "Use_Delay", b) ? "" : " (Use delay is off for it)"}.`,
        });
      }
    }
  }
  if (mainGroup.includes("Main")) {
    const pAgl = val(s, "AGL1", "Main") ?? 0;
    for (const b of mainGroup.filter((c) => c !== "Main")) {
      const bAgl = val(s, "AGL1", b) ?? 0;
      if (bAgl > pAgl || (bAgl === pAgl && delayOf(b) <= delayOf("Main"))) {
        out.push({
          level: "warn", channel: b,
          title: `Backup ${b} fires with or before Main`,
          detail: `${b} is set to ${bAgl} ft${delayOf(b) ? ` + ${delayOf(b)} s` : ""} and Main to ${pAgl} ft${delayOf("Main") ? ` + ${delayOf("Main")} s` : ""}. A backup normally sits 50 to 150 ft below the primary so it only fires if the main charge didn't.`,
        });
      }
    }
  }
  // 5) no redundancy, or nothing at apogee at all
  if (drogueGroup.length === 0 && mainGroup.length) out.push({ level: "info", title: "Nothing fires at apogee", detail: "No channel is set to fire around apogee, so the rocket falls on its main alone (single deploy) or ballistic until main altitude. Make sure that is the plan." });
  if (drogueGroup.length === 1) out.push({ level: "info", title: "No backup for the apogee event", detail: `Only ${drogueGroup[0]} fires near apogee. A second channel with a short extra delay covers a failed charge or e-match.` });
  if (mainGroup.length === 1) out.push({ level: "info", title: "No backup for the main", detail: `Only ${mainGroup[0]} fires at main altitude. A second channel set a little lower covers a failed charge.` });
  return out;
}
