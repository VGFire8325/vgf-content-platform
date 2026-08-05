// Explicit import (not just the type) so this compiles under both Next's
// automatic JSX runtime and tsx's classic-transform execution (used by
// the standalone render-check/integration scripts), which needs `React`
// in scope for JSX to resolve.
import React, { type ReactNode } from "react";

// Pinterest's recommended vertical pin ratio (2:3).
export const PINTEREST_PIN_WIDTH = 1000;
export const PINTEREST_PIN_HEIGHT = 1500;

// Fixed layouts only, per docs/PHASE_0_PLAN.md §1 — a drag-and-drop
// template editor is explicitly out of scope for V1. "Regenerate with a
// different template variant" cycles between these two from the review
// screen instead.
export type PinterestTemplateId = "photo-full-bleed" | "photo-top-text-bottom";
export const PINTEREST_TEMPLATE_IDS: PinterestTemplateId[] = ["photo-full-bleed", "photo-top-text-bottom"];

export interface PinterestTemplateProps {
  title: string;
  description: string;
  // Must already be a data: URI or a satori-resolvable src by the time
  // it reaches these templates — see resolveImageSrc() in render.ts.
  imageSrc: string;
}

// Placeholder brand colors — swap for VGF's real brand palette once
// Brendan supplies one; nothing else in the pipeline depends on these
// specific values.
const BRAND_DARK = "#1c1c1c";
const BRAND_ACCENT = "#c65d1e";

function photoFullBleed({ title, imageSrc }: PinterestTemplateProps): ReactNode {
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", position: "relative" }}>
      <img
        src={imageSrc}
        width={PINTEREST_PIN_WIDTH}
        height={PINTEREST_PIN_HEIGHT}
        style={{ objectFit: "cover", position: "absolute", top: 0, left: 0 }}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          display: "flex",
          flexDirection: "column",
          padding: "60px 48px 72px 48px",
          background: "linear-gradient(to top, rgba(0,0,0,0.85), rgba(0,0,0,0))",
        }}
      >
        <div style={{ color: "white", fontSize: 56, fontWeight: 700, lineHeight: 1.15 }}>{title}</div>
      </div>
    </div>
  );
}

function photoTopTextBottom({ title, description, imageSrc }: PinterestTemplateProps): ReactNode {
  const photoHeight = Math.round(PINTEREST_PIN_HEIGHT * 0.62);
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
      <img src={imageSrc} width={PINTEREST_PIN_WIDTH} height={photoHeight} style={{ objectFit: "cover" }} />
      <div
        style={{
          flexGrow: 1,
          width: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "48px",
          background: BRAND_DARK,
        }}
      >
        <div style={{ color: BRAND_ACCENT, fontSize: 24, fontWeight: 700, textTransform: "uppercase", letterSpacing: 2 }}>
          Very Good Fireplaces
        </div>
        <div style={{ color: "white", fontSize: 48, fontWeight: 700, lineHeight: 1.2, marginTop: 16 }}>{title}</div>
        <div style={{ color: "#cccccc", fontSize: 26, lineHeight: 1.4, marginTop: 20 }}>{description}</div>
      </div>
    </div>
  );
}

export const PINTEREST_TEMPLATES: Record<PinterestTemplateId, (props: PinterestTemplateProps) => ReactNode> = {
  "photo-full-bleed": photoFullBleed,
  "photo-top-text-bottom": photoTopTextBottom,
};
