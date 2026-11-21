// One ZIP with everything the site worked out for a flight: the derived time series as CSV and
// the key numbers as JSON, for team reports, spreadsheets and MATLAB. Always in feet, seconds
// and g (the site's display units don't apply), as the README inside says.
import { strToU8, zipSync } from "fflate";
import type { Analysis } from "./analysis";
import { indexAt } from "./analysis";
import type { BlueRavenFlight } from "./parsers/blueRaven";
import { aeroSeries } from "./aero";

const f3 = (v: number) => (Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : "");

function csv(head: string[], n: number, col: (k: number, i: number) => number): string {
  const out = [head.join(",")];
  for (let i = 0; i < n; i++) out.push(head.map((_, k) => f3(col(k, i))).join(","));
  return out.join("\n");
}

export function buildExport(f: BlueRavenFlight, a: Analysis, extra: Record<string, unknown>): Uint8Array {
  const lr = f.lr!, hr = f.hr;
  const aero = aeroSeries(f, a);
  const lrCols: [string, (i: number) => number][] = [
    ["t_s", (i) => lr.t[i]],
    ["baro_agl_raw_ft", (i) => lr.baroAsl[i] - a.padAsl],
    ["baro_agl_filtered_ft", (i) => a.altSmooth[i]],
    ["inertial_alt_ft", (i) => lr.inAlt[i]],
    ["baro_vel_ft_s", (i) => a.baroVel[i]],
    ["inertial_vel_up_ft_s", (i) => lr.velUp[i]],
    ["inertial_vel_total_ft_s", (i) => a.totalVel[i]],
    ["tilt_deg", (i) => lr.tilt[i]],
    ["temp_F", (i) => lr.tempF[i]],
    ["pressure_atm", (i) => lr.pressAtm[i]],
    ["battery_V", (i) => lr.battV[i]],
    ["mach", (i) => aero?.mach[i] ?? NaN],
    ["q_psf", (i) => aero?.qPsf[i] ?? NaN],
    ["gps_alt_agl_ft", (i) => a.gps?.altOnLR[i] ?? NaN],
  ];
  const files: Record<string, Uint8Array> = {
    "lowrate_50hz.csv": strToU8(csv(lrCols.map((c) => c[0]), lr.n, (k, i) => lrCols[k][1](i))),
    "path_3d.csv": strToU8(csv(["t_s", "x_ft", "up_ft", "z_ft"], a.path.t.length, (k, i) => [a.path.t[i], a.path.x[i], a.path.y[i], a.path.z[i]][k])),
    "events.csv": strToU8(["event,t_s,alt_ft", ...a.events.map((e) => `${e.label},${f3(e.t)},${f3(a.altSmooth[indexAt(lr.t, e.t)])}`)].join("\n")),
    "metrics.csv": strToU8(["metric,site,device,unit", ...a.metrics.map((m) => `"${m.label}",${f3(m.site ?? NaN)},${f3(m.device ?? NaN)},${m.unit}`)].join("\n")),
  };
  if (hr && a.axialAccel) {
    files["highrate_500hz.csv"] = strToU8(csv(["t_s", "axial_accel_g", "accel_mag_g", "roll_rate_deg_s"], hr.n, (k, i) => [hr.t[i], a.axialAccel![i], a.accelMag?.[i] ?? NaN, a.rollRate?.[i] ?? NaN][k]));
  }
  if (a.gps && f.gps) {
    const g = f.gps, al = a.gps;
    files["gps.csv"] = strToU8(csv(["t_s", "lat", "lon", "alt_agl_ft", "east_ft", "north_ft", "sats"], g.n, (k, i) => [al.t[i], g.lat[i], g.lon[i], g.altAgl[i], g.east[i], g.north[i], g.sats[i]][k]));
  }
  files["summary.json"] = strToU8(JSON.stringify({
    name: f.gps?.name ?? f.name,
    flightNumber: f.summary?.raw["Flight number"] ?? null,
    padAslFt: a.padAsl,
    maxQPsf: aero?.maxQ ?? null, maxMach: aero?.maxMach ?? null,
    gps: a.gps ? { offsetS: a.gps.offset, landing: a.gps.landing, rows: a.gps.rows } : null,
    warnings: a.warnings,
    ...extra,
  }, null, 2));
  files["README.txt"] = strToU8(`Data Compare export
Units: always feet, seconds, ft/s, g, degrees and psf, whatever the site's ft/m switch shows.
Time: seconds on the Blue Raven clock, liftoff near 0.

lowrate_50hz.csv   Blue Raven low-rate log plus the site's filtered altitude, Mach and dynamic pressure
highrate_500hz.csv acceleration along the rocket axis, total, and roll rate about the axis
path_3d.csv        the 3D trajectory (x and z horizontal, up), true east/north when GPS was aligned
gps.csv            GPS track on the Blue Raven clock
events.csv         liftoff, burnout, apogee, pyro fires, landing
metrics.csv        flight summary: site value and what the Blue Raven reported
summary.json       everything above in one place plus findings, descent, wind, coast drag, motor, ejection timing and notes
`);
  return zipSync(files, { level: 6 });
}
