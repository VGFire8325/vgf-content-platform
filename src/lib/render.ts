import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";
import type { ReactNode } from "react";
import {
  PINTEREST_PIN_HEIGHT,
  PINTEREST_PIN_WIDTH,
  PINTEREST_TEMPLATES,
  type PinterestTemplateId,
  type PinterestTemplateProps,
} from "./templates/pinterest";
import { INSTAGRAM_SLIDE_SIZE, instagramSlide, type InstagramSlideProps } from "./templates/instagram";

// Liberation Sans — SIL Open Font License, freely redistributable.
// Placeholder until Brendan supplies VGF's real brand font; nothing else
// depends on this specific typeface.
const FONT_DIR = join(process.cwd(), "assets", "fonts");

type SatoriFont = { name: string; data: Buffer; weight: 400 | 700; style: "normal" };
let fontsCache: SatoriFont[] | null = null;

function loadFonts(): SatoriFont[] {
  if (!fontsCache) {
    fontsCache = [
      { name: "Liberation Sans", data: readFileSync(join(FONT_DIR, "LiberationSans-Regular.ttf")), weight: 400, style: "normal" },
      { name: "Liberation Sans", data: readFileSync(join(FONT_DIR, "LiberationSans-Bold.ttf")), weight: 700, style: "normal" },
    ];
  }
  return fontsCache;
}

export async function renderPinterestPin(
  templateId: PinterestTemplateId,
  props: PinterestTemplateProps,
): Promise<Buffer> {
  const template = PINTEREST_TEMPLATES[templateId];
  const jsx = template(props) as ReactNode;
  const svg = await satori(jsx, {
    width: PINTEREST_PIN_WIDTH,
    height: PINTEREST_PIN_HEIGHT,
    fonts: loadFonts(),
  });
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: PINTEREST_PIN_WIDTH } });
  return resvg.render().asPng();
}

export async function renderInstagramSlide(props: InstagramSlideProps): Promise<Buffer> {
  const jsx = instagramSlide(props) as ReactNode;
  const svg = await satori(jsx, {
    width: INSTAGRAM_SLIDE_SIZE,
    height: INSTAGRAM_SLIDE_SIZE,
    fonts: loadFonts(),
  });
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: INSTAGRAM_SLIDE_SIZE } });
  return resvg.render().asPng();
}

// Satori needs image bytes up front (it doesn't fetch remote URLs
// itself), so asset_library.file_url is resolved to a data: URI here
// before it reaches a template. Already-data: URIs pass through
// untouched — used by the integration check to avoid a real network
// fetch for a synthetic test asset.
export async function resolveImageSrc(fileUrl: string): Promise<string> {
  if (fileUrl.startsWith("data:")) {
    return fileUrl;
  }
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch source image ${fileUrl}: ${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "image/jpeg";
  const buffer = Buffer.from(await response.arrayBuffer());
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}
