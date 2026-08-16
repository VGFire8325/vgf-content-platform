// Verifies the Satori->resvg render pipeline actually produces valid
// PNGs, independent of Supabase Storage (which needs real credentials).
// Not part of the app; run with: npx tsx scripts/render-sample.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import assert from "node:assert/strict";
import { renderInstagramSlide, renderPinterestPin } from "../src/lib/render";
import { PINTEREST_TEMPLATE_IDS } from "../src/lib/templates/pinterest";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const outDir = mkdtempSync(join(tmpdir(), "vgf-render-sample-"));

function synthesizeTestPhoto(): string {
  // A simple gradient rectangle standing in for an approved product
  // photo — built with resvg so this script needs no external/binary
  // test fixtures.
  const svg = `<svg width="1000" height="1500" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#8a5a3a" />
        <stop offset="100%" stop-color="#2b1c12" />
      </linearGradient>
    </defs>
    <rect width="1000" height="1500" fill="url(#g)" />
  </svg>`;
  const png = new Resvg(svg).render().asPng();
  return `data:image/png;base64,${png.toString("base64")}`;
}

async function main() {
  const imageSrc = synthesizeTestPhoto();

  for (const templateId of PINTEREST_TEMPLATE_IDS) {
    const png = await renderPinterestPin(templateId, {
      title: "How to Size a Linear Electric Fireplace",
      description: "A quick guide to matching BTU output to room size before you buy.",
      imageSrc,
    });

    assert.ok(png.subarray(0, 8).equals(PNG_MAGIC), `${templateId}: output is not a valid PNG`);
    assert.ok(png.length > 5000, `${templateId}: output is suspiciously small (${png.length} bytes)`);

    const outPath = join(outDir, `pin-${templateId}.png`);
    writeFileSync(outPath, png);
    console.log(`${templateId}: OK, ${png.length} bytes -> ${outPath}`);
  }

  // Instagram carousel slide — same Satori->resvg path, but never
  // exercised end to end until the asset library had real matches
  // (every prior attempt short-circuited at needs_asset), which is how
  // a Satori layout violation here went undetected.
  const igPng = await renderInstagramSlide({
    slideText: "Compare 60 to 74 inch fireplaces for a standard large living room.",
    imageSrc,
    slideIndex: 0,
    slideCount: 3,
  });
  assert.ok(igPng.subarray(0, 8).equals(PNG_MAGIC), "instagram: output is not a valid PNG");
  assert.ok(igPng.length > 5000, `instagram: output is suspiciously small (${igPng.length} bytes)`);
  const igOutPath = join(outDir, "instagram-slide.png");
  writeFileSync(igOutPath, igPng);
  console.log(`instagram: OK, ${igPng.length} bytes -> ${igOutPath}`);

  console.log("\nRENDER CHECK PASSED");
}

main().catch((err) => {
  console.error("RENDER CHECK FAILED:", err);
  process.exit(1);
});
