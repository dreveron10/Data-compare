// Parachute sizing: the nominal diameter that gives a target descent rate, and the diameter the
// flown chutes behaved like. Steady descent: W = ½ ρ v² Cd A, A = π D² / 4.
export const RHO_SL = 0.0023769; // slug/ft^3

/** nominal diameter in inches for weight (lb), descent rate (ft/s), drag coefficient and air density */
export function diameterFor(weightLb: number, v: number, cd: number, rho = RHO_SL): number {
  const area = (2 * weightLb) / (rho * v * v * cd); // ft^2
  return Math.sqrt((4 * area) / Math.PI) * 12;
}

/** diameter in inches that a measured CdA (ft^2) corresponds to at an assumed Cd */
export const diameterFromCdA = (cdA: number, cd: number) => Math.sqrt((4 * (cdA / cd)) / Math.PI) * 12;
