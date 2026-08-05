import React, { type ReactNode } from "react";

// Instagram's recommended square ratio (1:1) — carousel items must all
// share the same dimensions.
export const INSTAGRAM_SLIDE_SIZE = 1080;

export interface InstagramSlideProps {
  slideText: string;
  // Must already be a data: URI or a satori-resolvable src, same
  // contract as PinterestTemplateProps — see resolveImageSrc() in render.ts.
  imageSrc: string;
  slideIndex: number; // 0-based
  slideCount: number;
}

// Same placeholder palette as the Pinterest templates — swap both once
// Brendan supplies VGF's real brand colors.
const BRAND_ACCENT = "#c65d1e";

export function instagramSlide({ slideText, imageSrc, slideIndex, slideCount }: InstagramSlideProps): ReactNode {
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", position: "relative" }}>
      <img
        src={imageSrc}
        width={INSTAGRAM_SLIDE_SIZE}
        height={INSTAGRAM_SLIDE_SIZE}
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
          padding: "56px 56px 64px 56px",
          background: "linear-gradient(to top, rgba(0,0,0,0.88), rgba(0,0,0,0))",
        }}
      >
        <div style={{ color: BRAND_ACCENT, fontSize: 26, fontWeight: 700, letterSpacing: 2 }}>
          {slideIndex + 1} / {slideCount}
        </div>
        <div style={{ color: "white", fontSize: 46, fontWeight: 700, lineHeight: 1.2, marginTop: 12 }}>
          {slideText}
        </div>
      </div>
    </div>
  );
}
