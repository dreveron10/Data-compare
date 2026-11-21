// Two altimeters in one rocket: where their deploy settings differ, channel by channel, in the
// same plain words as the settings panel (armed, delay, and what has to be true to fire).
// A difference can be on purpose (staggered backups) or a programming slip; this only lists them.

import { CHANNELS, type Channel, type DeploySettings } from "./parsers/blueRaven";
import { COND_MAP } from "./condLabels";

export interface SettingDiff { channel: Channel; item: string; a: string; b: string }

function describe(s: DeploySettings, ch: Channel) {
  const vals: Record<string, number> = {};
  for (const [k, v] of Object.entries(s.values)) vals[k] = v[ch];
  const conds = s.conditions.filter((c) => c.enabled[ch]).map((c) => COND_MAP[c.name]?.text(vals) ?? c.name.replace(/_/g, " "));
  return {
    armed: s.options["Arm_by_default"]?.[ch] === "TRUE" ? "armed" : "not armed",
    delay: s.options["Use_Delay"]?.[ch] === "TRUE" ? `${vals.delay} s` : "none",
    conds,
  };
}

export function settingsDiff(a: DeploySettings, b: DeploySettings): SettingDiff[] {
  const out: SettingDiff[] = [];
  for (const ch of CHANNELS) {
    const x = describe(a, ch), y = describe(b, ch);
    if (x.armed !== y.armed) out.push({ channel: ch, item: "Armed", a: x.armed, b: y.armed });
    if (x.delay !== y.delay) out.push({ channel: ch, item: "Delay", a: x.delay, b: y.delay });
    const onlyA = x.conds.filter((c) => !y.conds.includes(c)), onlyB = y.conds.filter((c) => !x.conds.includes(c));
    if (onlyA.length || onlyB.length) out.push({ channel: ch, item: "Fires when", a: onlyA.join(", ") || "nothing extra", b: onlyB.join(", ") || "nothing extra" });
  }
  return out;
}
