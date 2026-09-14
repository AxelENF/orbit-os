/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const useSearchParams = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ useSearchParams }));
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

import { MetaOAuthSelection } from "@/components/integrations/meta-oauth-page-selector";

const nonce = "11111111-1111-4111-8111-111111111111";
const organizationId = "00000000-0000-4000-8000-000000000001";
const pages = [
  { id: "page-1", name: "Página Uno", hasInstagram: true },
  { id: "page-2", name: "Página Dos", hasInstagram: false },
];

function selectQuery() {
  return new URLSearchParams({ metaOAuth: "select", nonce });
}

describe("MetaOAuthSelection", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useSearchParams.mockReset();
  });

  it("only appears for the callback selection query", () => {
    useSearchParams.mockReturnValue(new URLSearchParams());

    render(<MetaOAuthSelection onConnected={vi.fn()} />);

    expect(screen.queryByRole("heading", { name: "Selecciona la página de Facebook" })).not.toBeInTheDocument();
  });

  it("lists the discovered pages without displaying any token", async () => {
    useSearchParams.mockReturnValue(selectQuery());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ organizationId, pages }), { status: 200 }),
      ),
    );

    render(<MetaOAuthSelection onConnected={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Selecciona la página de Facebook" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Página Uno" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Página Dos" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("long-lived-user-token");
  });

  it("posts the selected page and notifies the settings page after success", async () => {
    useSearchParams.mockReturnValue(selectQuery());
    const onConnected = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ organizationId, pages }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<MetaOAuthSelection onConnected={onConnected} />);
    fireEvent.click(await screen.findByRole("button", { name: "Página Dos" }));

    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(organizationId));
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/integrations/meta/connect/select");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      body: JSON.stringify({ organizationId, nonce, pageId: "page-2" }),
    });
  });

  it("shows an actionable error when loading the pages fails", async () => {
    useSearchParams.mockReturnValue(selectQuery());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "META_OAUTH_SESSION_LOOKUP_FAILED" }), { status: 503 }),
      ),
    );

    render(<MetaOAuthSelection onConnected={vi.fn()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudieron cargar las páginas de Meta.");
  });

  it("explains an expired session and links to restart the connection", async () => {
    useSearchParams.mockReturnValue(selectQuery());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "META_OAUTH_SESSION_EXPIRED", organizationId }), { status: 400 }),
      ),
    );

    render(<MetaOAuthSelection onConnected={vi.fn()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("La sesión de conexión con Meta expiró.");
    expect(screen.getByRole("link", { name: "Reiniciar conexión de Meta" })).toHaveAttribute(
      "href",
      `/api/integrations/meta/connect?organizationId=${organizationId}`,
    );
  });
});
