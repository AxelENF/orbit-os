/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CompositeControls } from "@/components/logo-studio/composite-controls";

afterEach(() => cleanup());

describe("CompositeControls", () => {
  it("defaults to bottom-right, 15% size, 4% margin", () => {
    render(<CompositeControls value={{ corner: "bottom-right", sizePercent: 15, marginPercent: 4 }} onChange={vi.fn()} />);
    expect(screen.getByRole("radio", { name: /inferior derecha/i })).toBeChecked();
    expect(screen.getByLabelText(/tamaño/i)).toHaveValue("15");
    expect(screen.getByLabelText(/margen/i)).toHaveValue("4");
  });

  it("calls onChange with the selected corner", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<CompositeControls value={{ corner: "bottom-right", sizePercent: 15, marginPercent: 4 }} onChange={onChange} />);
    await user.click(screen.getByRole("radio", { name: /superior izquierda/i }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ corner: "top-left" }));
  });

  it("clamps the size slider to the 5-40 range", () => {
    render(<CompositeControls value={{ corner: "bottom-right", sizePercent: 15, marginPercent: 4 }} onChange={vi.fn()} />);
    const slider = screen.getByLabelText(/tamaño/i);
    expect(slider).toHaveAttribute("min", "5");
    expect(slider).toHaveAttribute("max", "40");
  });
});
