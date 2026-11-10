// P6.3 safe CSV. A spreadsheet runs a cell that starts with one of these as a formula, so such a
// cell gets a leading apostrophe and is shown as text (OWASP CSV injection guidance). Every cell
// is quoted, so commas, quotes and line breaks in a value can't start a new cell or row.
const FORMULA_START = /^[=+\-@\t\r＝＋－＠]/;

export function neutralize(value: string): string {
  // Leading spaces don't stop every spreadsheet from reading a formula, so look past them too.
  return FORMULA_START.test(value) || FORMULA_START.test(value.trimStart()) ? `'${value}` : value;
}

export function csvCell(value: string | number | boolean | null): string {
  const text = value === null ? "" : String(value);
  return `"${neutralize(text).replace(/"/g, '""')}"`;
}

export function toCsv(header: string[], rows: (string | number | boolean | null)[][]): string {
  return [header, ...rows]
    .map((r) => r.map(csvCell).join(","))
    .join("\r\n")
    .concat("\r\n");
}
