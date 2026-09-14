/** @vitest-environment node */
import { describe, expect, it } from "vitest";

import { computeLogoPlacement } from "@/lib/logo-studio/compose";

describe("computeLogoPlacement", () => {
  it("places the logo in the top-left corner with the given margin", () => {
    const placement = computeLogoPlacement(1080, 1350, 200, 100, { corner: "top-left", sizePercent: 15, marginPercent: 4 });
    expect(placement.x).toBeCloseTo(1080 * 0.04);
    expect(placement.y).toBeCloseTo(1080 * 0.04);
  });

  it("places the logo in the top-right corner with the given margin", () => {
    const margin = 1080 * 0.04;
    const placement = computeLogoPlacement(1080, 1350, 200, 100, { corner: "top-right", sizePercent: 15, marginPercent: 4 });
    expect(placement.x).toBeCloseTo(1080 - placement.width - margin);
    expect(placement.y).toBeCloseTo(margin);
  });

  it("places the logo in the bottom-left corner with the given margin", () => {
    const margin = 1080 * 0.04;
    const placement = computeLogoPlacement(1080, 1350, 200, 100, { corner: "bottom-left", sizePercent: 15, marginPercent: 4 });
    expect(placement.x).toBeCloseTo(margin);
    expect(placement.y).toBeCloseTo(1350 - placement.height - margin);
  });

  it("places the logo in the bottom-right corner with the given margin", () => {
    const margin = 1080 * 0.04;
    const placement = computeLogoPlacement(1080, 1350, 200, 100, { corner: "bottom-right", sizePercent: 15, marginPercent: 4 });
    expect(placement.x).toBeCloseTo(1080 - placement.width - margin);
    expect(placement.y).toBeCloseTo(1350 - placement.height - margin);
  });

  it("preserves the logo's aspect ratio", () => {
    const placement = computeLogoPlacement(1080, 1350, 400, 100, { corner: "top-left", sizePercent: 20, marginPercent: 4 });
    expect(placement.height / placement.width).toBeCloseTo(100 / 400);
  });

  it("clamps size so a very tall/narrow logo never exceeds the creative's own height, not just its width", () => {
    // logo natural 100x1000 (mucho más alto que ancho); sizePercent alto
    const placement = computeLogoPlacement(1080, 1350, 100, 1000, { corner: "top-left", sizePercent: 40, marginPercent: 10 });
    const margin = Math.min(1080, 1350) * 0.10;
    expect(placement.height).toBeLessThanOrEqual(1350 - margin * 2 + 0.01);
    expect(placement.width).toBeLessThanOrEqual(1080 - margin * 2 + 0.01);
  });

  it("throws for non-positive logo dimensions instead of dividing by zero", () => {
    expect(() => computeLogoPlacement(1080, 1350, 0, 100, { corner: "top-left", sizePercent: 15, marginPercent: 4 })).toThrow();
    expect(() => computeLogoPlacement(1080, 1350, 100, 0, { corner: "top-left", sizePercent: 15, marginPercent: 4 })).toThrow();
  });
});
