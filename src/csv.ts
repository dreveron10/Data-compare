// CSV text that Excel and Google Sheets open cleanly: numbers rounded to 2 decimals, text quoted
// when it holds a comma, quote or line break, and empty cells for missing values.

export type Cell = string | number | boolean | null | undefined;

export const csvCell = (v: Cell): string => {
  if (typeof v === "boolean") return v ? "yes" : "";
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(Math.round(v * 100) / 100) : "";
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

/** rows to CSV text (no BOM; add "\ufeff" when saving for Excel) */
export const toCsv = (rows: Cell[][]): string => rows.map((r) => r.map(csvCell).join(",")).join("\n");
