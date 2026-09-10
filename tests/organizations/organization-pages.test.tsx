/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

import OnboardingPage from "@/app/(app)/onboarding/page";
import OrganizationsSettingsPage from "@/app/(app)/settings/organizations/page";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
});
