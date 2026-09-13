/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const hasSupabaseBrowserConfig = vi.hoisted(() => vi.fn(() => false));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock("@/lib/supabase/client", () => ({ hasSupabaseBrowserConfig }));

import OnboardingPage from "@/app/(app)/onboarding/page";
import OrganizationsSettingsPage from "@/app/(app)/settings/organizations/page";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  hasSupabaseBrowserConfig.mockReset();
  hasSupabaseBrowserConfig.mockReturnValue(false);
});

describe("organization pages", () => {
  it("guides a user without organizations to the non-destructive setup path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ organizations: [], activeOrganizationId: null }), {
          status: 200,
        }),
      ),
    );

    render(<OnboardingPage />);

    expect(screen.getByRole("heading", { name: "Pon tu operación en contexto" })).toBeInTheDocument();
    expect(await screen.findByText("No hay organizaciones accesibles todavía.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Abrir gestión de organizaciones" })).toHaveAttribute(
      "href",
      "/settings/organizations",
    );
    expect(screen.getByRole("button", { name: "Crear organización (próximamente)" })).toBeDisabled();
  });

  it("shows organization cards and a safe placeholder for future creation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            organizations: [
              { id: "organization-a", name: "Clínica Norte", role: "owner" },
            ],
            activeOrganizationId: "organization-a",
          }),
          { status: 200 },
        ),
      ),
    );

    render(<OrganizationsSettingsPage />);

    expect(screen.getByRole("heading", { name: "Organizaciones" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Clínica Norte" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Propietario")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Crear organización (próximamente)" })).toBeDisabled();
  });

  it("shows Meta connection status, Instagram separately, and owner-only reconnect controls", async () => {
    hasSupabaseBrowserConfig.mockReturnValue(true);
    const ownerId = "organization-owner";
    const viewerId = "organization-viewer";
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          organizations: [
            { id: ownerId, name: "Clínica Norte", role: "owner" },
            { id: viewerId, name: "Clínica Sur", role: "viewer" },
          ],
          activeOrganizationId: ownerId,
        }), { status: 200 }))
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ERROR", facebookPageName: "Página Norte", hasInstagram: false }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ status: "NOT_CONNECTED" }), { status: 200 })),
    );

    render(<OrganizationsSettingsPage />);

    expect(await screen.findByText("Conexión con error")).toBeInTheDocument();
    expect(screen.getByText("No conectado")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Reconectar" })).toHaveAttribute(
      "href",
      `/api/integrations/meta/connect?organizationId=${ownerId}`,
    );
    const ownerCard = screen.getByRole("heading", { name: "Clínica Norte" }).closest("article");
    expect(ownerCard).not.toBeNull();
    expect(within(ownerCard!).getByLabelText("Instagram no conectado")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Conectar Facebook" })).not.toBeInTheDocument();
  });

  it("shows an active Facebook page and its independent Instagram indicator", async () => {
    hasSupabaseBrowserConfig.mockReturnValue(true);
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          organizations: [{ id: "organization-owner", name: "Clínica Norte", role: "owner" }],
          activeOrganizationId: "organization-owner",
        }), { status: 200 }))
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ACTIVE", facebookPageName: "Página Norte", hasInstagram: true }), { status: 200 })),
    );

    render(<OrganizationsSettingsPage />);

    expect(await screen.findByText("Conectado como Página Norte")).toBeInTheDocument();
    expect(screen.getByLabelText("Instagram conectado")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Desconectar" })).toBeInTheDocument();
  });
});
