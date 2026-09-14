/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => <a href={href} {...props}>{children}</a>,
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/library" }));
vi.mock("@/lib/supabase/client", () => ({ hasSupabaseBrowserConfig: () => true }));
vi.mock("@/components/aias/organization-switcher", () => ({ OrganizationSwitcher: () => <div data-testid="global-switcher" /> }));

import { AppShell } from "@/components/layout/app-shell";

afterEach(() => cleanup());

describe("AppShell", () => {
  afterEach(() => {
    cleanup();
  });

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

  it("includes a Configuración link to /settings/organizations with the settings icon", () => {
    render(<AppShell><p>Contenido</p></AppShell>);

    expect(screen.getByRole("link", { name: /Configuración/i })).toHaveAttribute("href", "/settings/organizations");
  });

  it("no longer claims publication always requires approval", () => {
    render(<AppShell><p>Contenido</p></AppShell>);

    expect(screen.queryByText("La publicación siempre requiere tu aprobación.")).not.toBeInTheDocument();
    expect(screen.getByText(/Publicamos automático cuando el diagnóstico no marca riesgo/)).toBeInTheDocument();
  });

  it("includes a Logo Studio link to /tools/logo-studio using the new image icon (not some other icon)", () => {
    render(<AppShell>content</AppShell>);
    const link = screen.getByRole("link", { name: /Logo Studio/i });
    expect(link).toHaveAttribute("href", "/tools/logo-studio");
    // Corrección ronda 1 (hallazgo real): el test anterior nunca verificaba
    // que el ícono fuera específicamente "image" — busca un fragmento del
    // path SVG único de ese ícono (ver Task 5, `cx="8.5" cy="8.5" r="1.5"`,
    // no compartido por ningún otro ícono existente) dentro del link.
    expect(link.innerHTML).toContain('cx="8.5"');
  });

  it("does not overlap the nav with the system-status panel (structural check — see Task 12 for real browser verification)", () => {
    render(<AppShell>content</AppShell>);
    const nav = screen.getByRole("navigation", { name: "Navegación principal" });
    // Corrección ronda 1 (bug real, no cosmético): el fix aplica
    // flex-1/overflow-y-auto al <div> que ENVUELVE a <nav> (nav.parentElement),
    // no a <nav> mismo — <nav> conserva su propia clase original
    // ("space-y-1"). La versión anterior comprobaba nav.className, que
    // nunca contiene "flex-1" pase lo que pase — ese assert no podía pasar
    // ni con el fix bien aplicado.
    expect(nav.parentElement?.className).toMatch(/flex-1/);
    expect(nav.parentElement?.className).toMatch(/overflow-y-auto/);

    // El panel "Estado del sistema" ya no debe estar posicionado `absolute`
    // — se busca el <details> directamente (no es pariente de <nav> ni
    // antes ni después del fix, así que nav.parentElement nunca lo alcanza).
    const statusPanel = screen.getByText("Estado del sistema").closest("details");
    expect(statusPanel?.className).not.toMatch(/\babsolute\b/);
  });
});

describe("AppShell global organization switcher", () => {
  it("does not render the global switcher on /tools/logo-studio (the page renders its own)", async () => {
    vi.doMock("next/navigation", () => ({ usePathname: () => "/tools/logo-studio" }));
    vi.resetModules();
    const { AppShell: FreshAppShell } = await import("@/components/layout/app-shell");
    render(<FreshAppShell>content</FreshAppShell>);
    expect(screen.queryByTestId("global-switcher")).not.toBeInTheDocument();
  });
});
