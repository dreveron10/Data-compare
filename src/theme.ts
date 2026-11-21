// Dark (default) and light themes. The 3D view stays dark in both; charts read their axis and
// grid colours from here so they follow the page.
export type Theme = "dark" | "light";
const KEY = "dc.theme";
const listeners: (() => void)[] = [];

export function getTheme(): Theme {
  try { return localStorage.getItem(KEY) === "light" ? "light" : "dark"; } catch { return "dark"; }
}
export function applyTheme(t: Theme = getTheme()) {
  document.documentElement.dataset.theme = t;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", t === "light" ? "#ffffff" : "#0d1524");
}
export function setTheme(t: Theme) {
  try { localStorage.setItem(KEY, t); } catch { /* ignore */ }
  applyTheme(t);
  listeners.forEach((f) => f());
}
export const onThemeChange = (f: () => void) => listeners.push(f);

export const axisColor = () => (getTheme() === "light" ? "#5b6884" : "#8a96b0");
export const gridColor = () => (getTheme() === "light" ? "rgba(20,33,59,0.12)" : "rgba(52,67,106,0.5)");
export const tickColor = () => (getTheme() === "light" ? "rgba(20,33,59,0.3)" : "rgba(52,67,106,0.8)");
/** near-white series colours become dark ink on the light theme */
export function ink(c: string): string {
  if (getTheme() !== "light") return c;
  if (/^#(f{3}|f{6})$/i.test(c)) return "#14213b";
  if (c === "#cfd6e4") return "#3b4863";
  const m = c.match(/^rgba\\((\\d+),\\s*(\\d+),\\s*(\\d+),\\s*([\\d.]+)\\)$/);
  if (m && +m[1] > 130 && +m[2] > 150 && +m[3] > 190) return `rgba(40,55,85,${m[4]})`;
  return c;
}
