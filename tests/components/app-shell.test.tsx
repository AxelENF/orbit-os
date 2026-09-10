// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/library",
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock("@/components/layout/runtime-mode", () => ({
  RuntimeMode: () => null,
}));

import { AppShell } from "@/components/layout/app-shell";

describe("AppShell", () => {
  it("exposes the campaign workspace and an accessible mobile menu", () => {
    render(<AppShell><p>Contenido</p></AppShell>);

    expect(screen.getAllByText("Campañas").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Abrir menú" })).toBeInTheDocument();
    expect(screen.getByText("Contenido")).toBeInTheDocument();
  });

  it("marks the current workspace route as active", () => {
    render(<AppShell><p>Contenido</p></AppShell>);

    expect(screen.getAllByRole("link", { name: /Campañas/ }).some((link) => link.getAttribute("aria-current") === "page")).toBe(true);
  });
});
