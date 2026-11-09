import { describe, expect, it } from "vitest";
import { csvCell, neutralize, toCsv } from "../../backend/src/domain/csv";

describe("P6.3 CSV safety", () => {
  it.each([
    ["=1+1", "'=1+1"],
    ["+SUM(A1)", "'+SUM(A1)"],
    ["-2", "'-2"],
    ["@cmd", "'@cmd"],
    ["\tlead", "'\tlead"],
    ["\rlead", "'\rlead"],
    ["＝1+1", "'＝1+1"],
    ["plain", "plain"],
    ["a=b", "a=b"],
    ["", ""],
  ])("neutralize(%j) is %j", (input, out) => {
    expect(neutralize(input)).toBe(out);
  });

  it("quotes every cell and doubles quotes, so commas and line breaks stay inside one cell", () => {
    expect(csvCell('a,"b"\r\nc')).toBe('"a,""b""\r\nc"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(3)).toBe('"3"');
    expect(toCsv(["h1", "h2"], [["=x", "y"]])).toBe('"h1","h2"\r\n"\'=x","y"\r\n');
  });
});
