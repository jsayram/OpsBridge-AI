import { describe, expect, it } from "vitest";
import { casePageSql } from "../../backend/src/repo/cases";

const base = {
  workspaceId: "00000000-0000-4000-8000-000000000009",
  seesTemplate: true,
  limit: 25,
};

describe("case page query", () => {
  it("binds every value and never puts input in the SQL text", () => {
    const evil = "x'; DROP TABLE app.cases; --";
    const { text, values } = casePageSql({ ...base, search: evil, status: evil });
    expect(text).not.toContain("DROP");
    expect(values).toContain(evil);
    expect(values).toContain(`%${evil}%`);
  });
  it("escapes LIKE wildcards so they match as text", () => {
    expect(casePageSql({ ...base, search: "50%_\\" }).values).toContain("%50\\%\\_\\\\%");
  });
  it("owner reads one branch, and a guest past its own rows reads only the template", () => {
    expect(casePageSql({ ...base, seesTemplate: false }).text).not.toContain("UNION ALL");
    const later = casePageSql({
      ...base,
      cursor: { rank: 1, at: "2026-01-01T00:00:00.000000Z", id: base.workspaceId },
    });
    expect(later.text).not.toContain("UNION ALL");
    expect(later.text).toContain("mode = 'template'");
    expect(casePageSql(base).text).toContain("UNION ALL");
  });
  it("always asks for one row past the page, so nextCursor is exact", () => {
    expect(casePageSql(base).values).toContain(26);
  });
});
