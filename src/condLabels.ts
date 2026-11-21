// Plain-language labels for the Blue Raven deployment conditions, and which logged flag or
// state shows each one in the low-rate file.
import { show } from "./units";

export const COND_MAP: Record<string, { flag?: string; state?: string; text: (v: Record<string, number>) => string }> = {
  "Alt_above_pad_<_AGL1": { flag: "LT_AGL1", text: (v) => `AGL < ${show(v.AGL1, "ft")}` },
  "Alt_above_pad_>_AGL2": { flag: "GT_AGL2", text: (v) => `AGL > ${show(v.AGL2, "ft")}` },
  "Flight_angle_<_FANG1": { flag: "LT_FANG1", text: (v) => `Tilt < ${v.FANG1}°` },
  "Flight_angle_>_FANG2": { flag: "GT_FANG2", text: (v) => `Tilt > ${v.FANG2}°` },
  "Future_Angle_>_FUTANG": { flag: "GT_FUTANG", text: (v) => `Future angle > ${v.FUTANG}°` },
  "Time_<_TVAL1": { flag: "LT_TVAL1", text: (v) => `Time < ${v.TVAL1} s` },
  "Time_>_TVAL2": { flag: "GT_TVAL2", text: (v) => `Time > ${v.TVAL2} s` },
  "Total_Velocity_<_VEL1": { flag: "LT_VEL1", text: (v) => `Velocity < ${show(v.VEL1, "ft/s")}` },
  "Total_Velocity_>_VEL2": { flag: "GT_VEL2", text: (v) => `Velocity > ${show(v.VEL2, "ft/s")}` },
  "Baro_velocity_<_BVEL": { flag: "LT_BVEL1", text: (v) => `Baro vel < ${show(v.BVEL1, "ft/s")}` },
  "Burnouts_>_BURNCOUNT": { flag: "GT_BURN", text: (v) => `Burnouts ≥ ${v.BRNCNT}` },
  "Channel_is_armed": { flag: "Armed", text: () => "Armed" },
  Liftoff: { state: "Liftoff", text: () => "Liftoff" },
  Apogee: { state: "Apogee", text: () => "Apogee" },
  Pressure_Increasing: { state: "Press_Increasing", text: () => "Pressure increasing" },
  Burnout_Coast: { state: "Burnout_Coast", text: () => "Coasting" },
  Apo_Fired: { state: "Apo_fired", text: () => "Apo fired" },
  Main_Fired: { state: "Main_fired", text: () => "Main fired" },
  "3rd_Fired": { state: "3rd_fired", text: () => "3rd fired" },
  "4th_Fired": { state: "4th_fired", text: () => "4th fired" },
  Normal_Ascent: { state: "Normal_Ascent", text: () => "Normal ascent" },
  "Accel velocity <= 0": { state: "Accel_Vel_LE_0", text: () => "Accel vel ≤ 0" },
  "ECI Vertical Vel <=0": { state: "ECI_Vvel_le_0", text: () => "Vertical vel ≤ 0" },
  "Tilt Exceeded 90 degrees": { state: "Tilt Exceeded 90deg", text: () => "Tilt > 90°" },
};
