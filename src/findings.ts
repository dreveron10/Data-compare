// Automatic findings: notable things in a flight worth a look, each tied to a time when possible.

import type { Analysis } from "./analysis";
import { indexAt, lowerBound } from "./analysis";
import { CHANNELS, type BlueRavenFlight, type Channel } from "./parsers/blueRaven";

export interface Finding {
  level: "warn" | "info" | "good";
  title: string;
  detail: string;
  t?: number;
}

export function findFindings(f: BlueRavenFlight, a: Analysis): Finding[] {
  const out: Finding[] = [];
  const lr = f.lr!;
  const ev = (k: string) => a.events.find((e) => e.key === k)?.t;
  const lift = ev("liftoff") ?? 0;
  const tApo = ev("apogee") ?? 0;
  const tLand = ev("landing") ?? lr.t[lr.n - 1];

  // 1) baro pressure transients (raw reading far from the filtered altitude)
  const spikes: { t0: number; t1: number; peak: number; raw: number; filt: number }[] = [];
  for (let i = lowerBound(lr.t, lift + 0.5); i < lr.n && lr.t[i] < tLand; i++) {
    const raw = lr.baroAsl[i] - a.padAsl;
    const d = raw - a.altSmooth[i];
    if (Math.abs(d) < 80) continue;
    const last = spikes[spikes.length - 1];
    if (last && lr.t[i] - last.t1 < 0.5) {
      last.t1 = lr.t[i];
      if (Math.abs(d) > Math.abs(last.peak)) { last.peak = d; last.raw = raw; last.filt = a.altSmooth[i]; }
    } else {
      spikes.push({ t0: lr.t[i], t1: lr.t[i], peak: d, raw, filt: a.altSmooth[i] });
    }
  }

  // 2) deployments: did a pressure spike trigger an altitude-based channel, and how far from its setting did it fire?
  const fireT: Partial<Record<Channel, number>> = {};
  for (const ch of CHANNELS) { const t = ev(`fire_${ch}`); if (t !== undefined) fireT[ch] = t; }
  const explained = new Set<(typeof spikes)[number]>();
  for (const ch of CHANNELS) {
    const t = fireT[ch];
    if (t === undefined) continue;
    const setting = f.settings;
    const usesAgl = setting?.conditions.find((c) => c.name === "Alt_above_pad_<_AGL1")?.enabled[ch];
    const agl1 = setting?.values["AGL1"]?.[ch];
    const trueAlt = a.altSmooth[indexAt(lr.t, t)];
    const spike = spikes.find((s) => t >= s.t0 - 0.3 && t <= s.t1 + 0.6);
    if (usesAgl && agl1 !== undefined) {
      if (spike && spike.raw < agl1 && trueAlt > agl1 + 30) {
        explained.add(spike);
        out.push({
          level: "warn",
          title: `${ch} fired on a pressure spike`,
          detail: `Baro briefly read ${spike.raw.toFixed(0)} ft while the rocket was near ${trueAlt.toFixed(0)} ft, which met the "below ${agl1} ft" condition early.`,
          t,
        });
      } else if (trueAlt > agl1 + 60) {
        out.push({ level: "warn", title: `${ch} fired above its setting`, detail: `Fired at about ${trueAlt.toFixed(0)} ft for a ${agl1} ft setting.`, t });
      }
    }
  }
  for (const s of spikes) {
    if (explained.has(s)) continue;
    out.push({
      level: "info",
      title: "Baro pressure spike",
      detail: `Raw altitude jumped ${s.peak > 0 ? "+" : ""}${s.peak.toFixed(0)} ft for ${Math.max(0.02, s.t1 - s.t0).toFixed(2)} s (often a separation or ejection charge).`,
      t: s.t0,
    });
  }

  // 3) ascent attitude
  const rr = a.metrics.find((m) => m.label === "Max roll rate (ascent)")?.site ?? null;
  const rolls = a.metrics.find((m) => m.label === "Ascent rolls")?.site ?? null;
  if (rr !== null && rr > 200) {
    let tPeak: number | undefined;
    if (f.hr && a.rollRate) {
      let best = 0;
      for (let i = lowerBound(f.hr.t, lift); i < f.hr.n && f.hr.t[i] <= tApo; i++) if (Math.abs(a.rollRate[i]) > best) { best = Math.abs(a.rollRate[i]); tPeak = f.hr.t[i]; }
    }
    out.push({ level: "warn", title: "High roll rate on ascent", detail: `Peaked at ${rr.toFixed(0)} °/s, ${rolls?.toFixed(1) ?? "?"} turns to apogee. Check fin alignment or cant.`, t: tPeak });
  }
  const tBurn = ev("burnout");
  const tiltBurn = a.metrics.find((m) => m.label === "Tilt at burnout")?.site ?? null;
  if (tiltBurn !== null && tiltBurn > 15) {
    out.push({ level: "warn", title: "Large tilt at burnout", detail: `${tiltBurn.toFixed(1)}° from vertical. Weathercocking or a canted rail costs altitude.`, t: tBurn });
  }

  // 4) battery dips (pyro current pulling the battery down)
  const padV = lr.battV[Math.max(0, lowerBound(lr.t, lift) - 1)];
  let minV = Infinity, tMin = lift;
  for (let i = lowerBound(lr.t, lift); i < lr.n; i++) if (lr.battV[i] < minV) { minV = lr.battV[i]; tMin = lr.t[i]; }
  if (Number.isFinite(minV) && padV - minV > 1) {
    out.push({ level: "info", title: "Battery dipped during a pyro fire", detail: `${padV.toFixed(2)} V on the pad, down to ${minV.toFixed(2)} V. It recovered, but a weaker battery could brown out.`, t: tMin });
  }

  // 5) deployment shocks
  if (f.hr && a.accelMag) {
    const shocks: { t: number; g: number }[] = [];
    for (let i = lowerBound(f.hr.t, tApo); i < f.hr.n; i++) {
      const g = a.accelMag[i];
      if (g < 40) continue;
      const last = shocks[shocks.length - 1];
      if (last && f.hr.t[i] - last.t < 1) { if (g > last.g) { last.g = g; last.t = f.hr.t[i]; } }
      else shocks.push({ t: f.hr.t[i], g });
    }
    for (const s of shocks.slice(0, 4)) {
      const landing = Math.abs(s.t - tLand) < 1.5;
      out.push({
        level: "warn",
        title: landing ? "Hard landing shock" : "Large deployment shock",
        detail: `${s.g.toFixed(0)} g peak${landing ? " at touchdown" : ". Consider a longer shock cord, a deployment bag or a slower opening."}`,
        t: s.t,
      });
    }
  }

  // 6) apogee detection lag
  const det = ev("apogee_det");
  if (det !== undefined && det - tApo > 0.8) {
    out.push({ level: "info", title: "Apogee detected late", detail: `The Blue Raven flagged apogee ${(det - tApo).toFixed(1)} s after the baro peak.`, t: det });
  }

  // 7) inertial vs GPS
  if (a.gps) {
    const apoDist = a.gps.rows.find((r) => r.label === "Distance at apogee")?.gps ?? 0;
    if (apoDist > 300 && a.gps.ascentRms / apoDist > 0.06) {
      out.push({ level: "info", title: "Inertial position drifted from GPS", detail: `Ascent tracks differ by ${a.gps.ascentRms.toFixed(0)} ft RMS (${((a.gps.ascentRms / apoDist) * 100).toFixed(0)}% of the distance at apogee). Normal for IMU-only navigation.` });
    }
  }

  // 8) data quality
  out.push(...dataQuality(f, a, lift, tLand));

  // a pyro channel that fired well before apogee (while the rocket was still climbing fast)
  for (const ch of CHANNELS) {
    const t = fireT[ch];
    if (t === undefined || !(t > lift) || t > tApo - 1) continue;
    const i = indexAt(lr.t, t);
    out.push({
      level: "warn",
      title: `${ch} fired before apogee`,
      detail: `${ch} fired ${(tApo - t).toFixed(1)} s before apogee, climbing at ${lr.velUp[i].toFixed(0)} ft/s at ${a.altSmooth[i].toFixed(0)} ft. If it isn't an intentional event (staging, airbrake), check its conditions and delay.`,
      t,
    });
  }
  out.sort((x, y) => (x.t ?? 1e9) - (y.t ?? 1e9));
  if (!out.some((x) => x.level === "warn")) out.unshift({ level: "good", title: "Nothing unusual found", detail: "Deployments matched their settings and no large shocks, spikes or attitude problems were detected." });
  return out;
}

function gapsIn(t: ArrayLike<number>, t0: number, t1: number) {
  const n = t.length;
  if (n < 10) return { count: 0, longest: 0, at: 0, nominal: 0 };
  const d: number[] = [];
  for (let i = 1; i < Math.min(n, 2000); i++) d.push(t[i] - t[i - 1]);
  d.sort((x, y) => x - y);
  const nominal = d[Math.floor(d.length / 2)];
  let count = 0, longest = 0, at = 0;
  for (let i = lowerBound(t, t0) + 1; i < n && t[i] <= t1; i++) {
    const g = t[i] - t[i - 1];
    if (g > Math.max(nominal * 4, 0.05)) {
      count++;
      if (g > longest) { longest = g; at = t[i - 1]; }
    }
  }
  return { count, longest, at, nominal };
}

function dataQuality(f: BlueRavenFlight, a: Analysis, lift: number, tLand: number): Finding[] {
  const out: Finding[] = [];
  const lr = f.lr!;
  // log gaps during the flight
  const lg = gapsIn(lr.t, lift, tLand);
  if (lg.count > 0) {
    out.push({ level: "info", title: "Gaps in the low-rate log", detail: `${lg.count} gap${lg.count > 1 ? "s" : ""} longer than normal (${(lg.nominal * 1000).toFixed(0)} ms spacing); the longest is ${lg.longest.toFixed(2)} s.`, t: lg.at });
  }
  if (f.hr) {
    const hg = gapsIn(f.hr.t, lift, tLand);
    if (hg.count > 0) {
      out.push({ level: "info", title: "Gaps in the high-rate log", detail: `${hg.count} gap${hg.count > 1 ? "s" : ""}, the longest ${hg.longest.toFixed(2)} s. Attitude is interpolated across them.`, t: hg.at });
    }
    // accelerometer clipping: the same extreme value held for several samples
    const names = ["X", "Y", "Z"];
    for (let k = 0; k < 3; k++) {
      let peak = 0;
      for (let i = 0; i < f.hr.n; i++) peak = Math.max(peak, Math.abs(f.hr.accel[i * 3 + k]));
      if (peak < 8) continue;
      let run = 0, best = 0, at = 0;
      for (let i = 0; i < f.hr.n; i++) {
        if (Math.abs(Math.abs(f.hr.accel[i * 3 + k]) - peak) < 1e-3) { run++; if (run > best) { best = run; at = f.hr.t[i]; } }
        else run = 0;
      }
      if (best >= 3) {
        out.push({ level: "warn", title: `Accelerometer ${names[k]} axis clipped`, detail: `Stuck at ±${peak.toFixed(1)} g for ${best} samples. Real peaks were higher than logged.`, t: at });
      }
    }
  }
  // gyro overload reported by the Blue Raven
  const gyroT = f.summary?.num["Time to gyro overload"];
  if (gyroT && gyroT > 0) {
    out.push({ level: "info", title: "Gyro overloaded", detail: "The Blue Raven reported its gyro range was exceeded; attitude after this point is less reliable.", t: lift + gyroT });
  }
  // clock mismatch between Blue Raven and GPS
  if (f.gps && lr.clock.length) {
    const iL = Math.max(0, lowerBound(lr.t, lift));
    const brMs = Date.parse(`${lr.date}T${lr.clock[iL]}Z`);
    const gpsMs = f.gps.launchUtcMs ?? f.gps.launchUnix * 1000;
    if (Number.isFinite(brMs)) {
      const diffS = (brMs - gpsMs) / 1000;
      if (Math.abs(diffS) > 60) {
        const days = Math.trunc(diffS / 86400);
        const hrs = Math.round((diffS - days * 86400) / 3600);
        const parts = [days ? `${Math.abs(days)} day${Math.abs(days) > 1 ? "s" : ""}` : "", hrs ? `${Math.abs(hrs)} h` : ""].filter(Boolean).join(" ");
        out.push({
          level: "info",
          title: "Blue Raven clock doesn't match GPS time",
          detail: `Its clock is ${parts || `${Math.round(Math.abs(diffS))} s`} ${diffS < 0 ? "behind" : "ahead of"} GPS time (UTC). Analysis uses flight time so nothing here is affected, but set the clock in the Featherweight app so file names and dates match.`,
        });
      }
    }
    // the tracker's own two time columns disagree (seen in Featherweight exports: UNIXTIME shifted by the PC time zone)
    if (f.gps.launchUtcMs !== null) {
      const off = f.gps.launchUnix - f.gps.launchUtcMs / 1000;
      if (Math.abs(off) > 60) {
        out.push({
          level: "info",
          title: "GPS export has a shifted UNIX time",
          detail: `The tracker's UNIXTIME column is ${(Math.abs(off) / 3600).toFixed(1)} h ${off > 0 ? "ahead of" : "behind"} its UTC time column, so KML files made from it show the wrong time. This tool uses the UTC column.`,
        });
      }
    }
    // GPS satellites during flight
    let minSats = 99, tMin = lift;
    for (let i = 0; i < f.gps.n; i++) {
      const tt = f.gps.t[i] + (a.gps?.offset ?? 0);
      if (tt < lift || tt > tLand) continue;
      if (f.gps.sats[i] < minSats) { minSats = f.gps.sats[i]; tMin = tt; }
    }
    if (minSats < 6) out.push({ level: "warn", title: "GPS lost satellites", detail: `Dropped to ${minSats} satellites; positions around this time may be poor.`, t: tMin });
  }
  return out;
}
