// Deterministic synthetic PDFs. All content is fictional.
import { PDFDocument, StandardFonts } from "pdf-lib";
import { writeFileSync } from "node:fs";
const line = (i) => `Northstar Operations synthetic intake sheet line ${i}: Fictional Client Ltd, internal case NS-${1000 + i}, service dates 2026-03-01 to 2026-09-30, checklist item ${i % 7} complete.`;
async function make(pages, file) {
  const doc = await PDFDocument.create();
  doc.setCreationDate(new Date("2026-01-01T00:00:00Z")); doc.setModificationDate(new Date("2026-01-01T00:00:00Z"));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage([612, 792]);
    for (let i = 0; i < 45; i++) page.drawText(line(p * 45 + i), { x: 36, y: 750 - i * 15, size: 8, font });
  }
  writeFileSync(file, await doc.save());
}
await make(1, "fixtures/synthetic-1p.pdf"); await make(5, "fixtures/synthetic-5p.pdf"); await make(20, "fixtures/synthetic-20p.pdf");
