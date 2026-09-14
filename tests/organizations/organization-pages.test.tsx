/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const hasSupabaseBrowserConfig = vi.hoisted(() => vi.fn(() => false));
const useSearchParams = vi.hoisted(() => vi.fn(() => new URLSearchParams()));

vi.mock("next/navigation", () => ({ useSearchParams }));

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
  useSearchParams.mockReset();
  useSearchParams.mockReturnValue(new URLSearchParams());
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

  it("shows the discovered Meta pages after the OAuth callback redirects with a selection nonce", async () => {
    hasSupabaseBrowserConfig.mockReturnValue(true);
    useSearchParams.mockReturnValue(
      new URLSearchParams({
        metaOAuth: "select",
        nonce: "11111111-1111-4111-8111-111111111111",
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string) => {
        const url = new URL(input, "https://orbit.example");
        if (url.pathname === "/api/organizations") {
          return Promise.resolve(new Response(JSON.stringify({
            organizations: [{ id: "organization-owner", name: "Clínica Norte", role: "owner" }],
            activeOrganizationId: "organization-owner",
          }), { status: 200 }));
        }
        if (url.pathname === "/api/integrations/meta/status") {
          return Promise.resolve(new Response(JSON.stringify({ status: "NOT_CONNECTED", hasInstagram: false }), { status: 200 }));
        }
        if (url.pathname === "/api/organizations/organization-owner/profile") {
          return Promise.resolve(new Response(null, { status: 404 }));
        }
        if (url.pathname === "/api/integrations/meta/connect/select") {
          return Promise.resolve(new Response(JSON.stringify({
            organizationId: "organization-owner",
            pages: [{ id: "page-1", name: "Página Uno", hasInstagram: true }],
          }), { status: 200 }));
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(<OrganizationsSettingsPage />);

    expect(await screen.findByRole("heading", { name: "Selecciona la página de Facebook" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Página Uno" })).toBeInTheDocument();
  });

  it("refreshes the Meta status after selecting a page and shows the connected page name", async () => {
    hasSupabaseBrowserConfig.mockReturnValue(true);
    useSearchParams.mockReturnValue(
      new URLSearchParams({
        metaOAuth: "select",
        nonce: "11111111-1111-4111-8111-111111111111",
      }),
    );
    let statusReads = 0;
    const fetchMock = vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      const url = new URL(input, "https://orbit.example");
      if (url.pathname === "/api/organizations") {
        return Promise.resolve(new Response(JSON.stringify({
          organizations: [{ id: "organization-owner", name: "Clínica Norte", role: "owner" }],
          activeOrganizationId: "organization-owner",
        }), { status: 200 }));
      }
      if (url.pathname === "/api/organizations/organization-owner/profile") {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      if (url.pathname === "/api/integrations/meta/status") {
        statusReads += 1;
        return Promise.resolve(new Response(JSON.stringify(
          statusReads === 1
            ? { status: "NOT_CONNECTED", hasInstagram: false }
            : { status: "ACTIVE", facebookPageName: "Página Uno", hasInstagram: true },
        ), { status: 200 }));
      }
      if (url.pathname === "/api/integrations/meta/connect/select" && init?.method === "POST") {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (url.pathname === "/api/integrations/meta/connect/select") {
        return Promise.resolve(new Response(JSON.stringify({
          organizationId: "organization-owner",
          pages: [{ id: "page-1", name: "Página Uno", hasInstagram: true }],
        }), { status: 200 }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<OrganizationsSettingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Página Uno" }));

    expect(await screen.findByText("Conectado como Página Uno")).toBeInTheDocument();
    expect(statusReads).toBe(2);
  });

  it("does not let the initial Meta status read overwrite the post-selection refresh", async () => {
    hasSupabaseBrowserConfig.mockReturnValue(true);
    useSearchParams.mockReturnValue(
      new URLSearchParams({
        metaOAuth: "select",
        nonce: "11111111-1111-4111-8111-111111111111",
      }),
    );
    let statusReads = 0;
    let releaseInitialStatus!: (response: Response) => void;
    const initialStatus = new Promise<Response>((resolve) => {
      releaseInitialStatus = resolve;
    });
    const fetchMock = vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      const url = new URL(input, "https://orbit.example");
      if (url.pathname === "/api/organizations") {
        return Promise.resolve(new Response(JSON.stringify({
          organizations: [{ id: "organization-owner", name: "Clínica Norte", role: "owner" }],
          activeOrganizationId: "organization-owner",
        }), { status: 200 }));
      }
      if (url.pathname === "/api/organizations/organization-owner/profile") {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      if (url.pathname === "/api/integrations/meta/status") {
        statusReads += 1;
        return statusReads === 1
          ? initialStatus
          : Promise.resolve(new Response(JSON.stringify({
            status: "ACTIVE",
            facebookPageName: "Página Uno",
            hasInstagram: true,
          }), { status: 200 }));
      }
      if (url.pathname === "/api/integrations/meta/connect/select" && init?.method === "POST") {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (url.pathname === "/api/integrations/meta/connect/select") {
        return Promise.resolve(new Response(JSON.stringify({
          organizationId: "organization-owner",
          pages: [{ id: "page-1", name: "Página Uno", hasInstagram: true }],
        }), { status: 200 }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<OrganizationsSettingsPage />);
    expect(await screen.findByRole("button", { name: "Página Uno" })).toBeInTheDocument();
    await waitFor(() => expect(statusReads).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: "Página Uno" }));
    await waitFor(() => expect(statusReads).toBe(2));
    expect(await screen.findByText("Conectado como Página Uno")).toBeInTheDocument();

    releaseInitialStatus(new Response(JSON.stringify({ status: "NOT_CONNECTED", hasInstagram: false }), { status: 200 }));

    expect(await screen.findByText("Conectado como Página Uno")).toBeInTheDocument();
  });
});
