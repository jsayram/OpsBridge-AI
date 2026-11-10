import { PDFDocument, StandardFonts } from "pdf-lib";
import { writeFileSync, readFileSync } from "node:fs";
// Image-only page, standing in for a scan: no text layer at all.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const d = await PDFDocument.create(); const img = await d.embedPng(png); const p = d.addPage([612, 792]); p.drawImage(img, { x: 0, y: 0, width: 612, height: 792 });
writeFileSync("fixtures/synthetic-imageonly.pdf", await d.save());
// 100 pages: the size at which a limit has to exist.
const big = await PDFDocument.create(); const f = await big.embedFont(StandardFonts.Helvetica);
for (let i = 0; i < 100; i++) { const pg = big.addPage([612, 792]); for (let l = 0; l < 45; l++) pg.drawText(`Synthetic line ${i}-${l} for a fictional operations record, no real data.`, { x: 36, y: 750 - l * 15, size: 8, font: f }); }
writeFileSync("fixtures/synthetic-100p.pdf", await big.save());
writeFileSync("fixtures/malformed.pdf", Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("not really a pdf".repeat(50))]));
