/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OrganizationSwitcher,
  parseOrganizationsResponse,
  type OrganizationOption,
} from "@/components/aias/organization-switcher";

const organizations: OrganizationOption[] = [
  { id: "organization-a", name: "Clínica Norte", role: "owner" },
  { id: "organization-b", name: "Restaurante Centro", role: "editor" },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OrganizationSwitcher", () => {
  it("rejects malformed active organization payloads", () => {
    expect(
      parseOrganizationsResponse({
        organizations,
        activeOrganizationId: "",
      }),
    ).toBeNull();
    expect(
      parseOrganizationsResponse({
        organizations,
        activeOrganizationId: "organization-other",
      }),
    ).toBeNull();
  });

  it("posts a validated selection and exposes the new active organization", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ organizationId: "organization-b" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <OrganizationSwitcher
        organizations={organizations}
        activeOrganizationId="organization-a"
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Organización activa" }), {
      target: { value: "organization-b" },
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/organizations/active",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ organizationId: "organization-b" }),
      }),
    );
    expect(await screen.findByText("Restaurante Centro está activa.")).toBeInTheDocument();
  });

  it("keeps the previous selection and announces an API error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "ORGANIZATION_ACCESS_DENIED" }), { status: 403 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <OrganizationSwitcher
        organizations={organizations}
        activeOrganizationId="organization-a"
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Organización activa" }), {
      target: { value: "organization-b" },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No tienes acceso a esa organización.",
    );
    expect(screen.getByRole("combobox", { name: "Organización activa" })).toHaveValue(
      "organization-a",
    );
  });
});
