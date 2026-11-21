// Vehicle numbers shared by Coast drag, Motor and the Vehicle card: one place to type them,
// remembered per vehicle name (from the saved flight) so each rocket keeps its own.
export interface Vehicle {
  burnoutLb: number | null; // mass after the motor burns out
  propLb: number | null; // propellant mass
  diaIn: number; // body tube outer diameter
  ratedNs: number | null; // motor's rated total impulse
  railFt: number; // distance the rocket travels before it leaves the rail
}
const KEY = "dc.vehicles";
const blank = (): Vehicle => ({ burnoutLb: null, propLb: null, diaIn: 6, ratedNs: null, railFt: 10 });

function all(): Record<string, Vehicle> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (v && typeof v === "object") return v;
  } catch { /* ignore */ }
  // first run: carry over what the Coast drag and Motor panels stored before this card existed
  const d = blank();
  try {
    const c = JSON.parse(localStorage.getItem("dc.coast") ?? "null");
    if (c) { d.burnoutLb = c.massLb ?? null; if (typeof c.diaIn === "number") d.diaIn = c.diaIn; }
    const m = JSON.parse(localStorage.getItem("dc.motor") ?? "null");
    if (m) { d.propLb = m.propLb ?? null; d.ratedNs = m.ratedNs ?? null; }
  } catch { /* ignore */ }
  return { default: d };
}

export const vehicleKeyOf = (name?: string | null) => (name && name.trim() ? name.trim().toLowerCase() : "default");

export function getVehicle(key: string): Vehicle {
  const a = all();
  return { ...blank(), ...(a[key] ?? a.default ?? {}) };
}

export function setVehicle(key: string, v: Vehicle) {
  const a = all();
  a[key] = v;
  try { localStorage.setItem(KEY, JSON.stringify(a)); } catch { /* full or blocked */ }
}

/** vehicle names that have numbers stored (the default one excluded) */
export function vehicleNames(): string[] {
  return Object.keys(all()).filter((k) => k !== "default");
}
