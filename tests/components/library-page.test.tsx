/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));
vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: (props: Record<string, unknown>) => <img {...(props as Record<string, string>)} alt={props.alt as string} />,
}));
const hasSupabaseBrowserConfig = vi.fn(() => true);
vi.mock("@/lib/supabase/client", () => ({ hasSupabaseBrowserConfig: () => hasSupabaseBrowserConfig() }));

const listContentSummaries = vi.fn();
const getContentRecord = vi.fn();
const approveContentTarget = vi.fn();
const retryContentTarget = vi.fn();
vi.mock("@/lib/content/client", () => ({
  listContentSummaries: (...args: unknown[]) => listContentSummaries(...args),
  getContentRecord: (...args: unknown[]) => getContentRecord(...args),
  approveContentTarget: (...args: unknown[]) => approveContentTarget(...args),
  retryContentTarget: (...args: unknown[]) => retryContentTarget(...args),
}));
const readDemoDrafts = vi.fn();
const approveDemoTarget = vi.fn();
vi.mock("@/lib/demo/draft-store", () => ({
  readDemoDrafts: (...args: unknown[]) => readDemoDrafts(...args),
  approveDemoTarget: (...args: unknown[]) => approveDemoTarget(...args),
}));
// Declarado aquí desde el inicio (no en el Ciclo C, donde se usa por
// primera vez) — corrección tras revisión de Codex CLI ronda 3: un
// afterEach que resetea este mock necesita que ya exista como variable
// en este punto del archivo, y vi.mock ya se hoistea al tope del módulo
// de todas formas, así que no hay costo en declararlo temprano junto a
// los demás mocks en vez de partido entre dos ciclos distintos.
const useSearchParams = vi.hoisted(() => vi.fn(() => new URLSearchParams()));
vi.mock("next/navigation", () => ({ useSearchParams }));

import LibraryPage from "@/app/(app)/library/page";

function summary(id: string, state: string, hasActionableTarget: boolean) {
  return { id, state, createdAt: "2026-09-14T00:00:00.000Z", service: "bot_whatsapp", niche: "clinicas", contentType: "venta_directa", objective: "agenda_demo", hasActionableTarget };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // vi.clearAllMocks() clears call history but NOT a .mockReturnValue()
  // override (only .mockReset() does that) — without these two lines,
  // Cycle B's hasSupabaseBrowserConfig.mockReturnValue(false) and Cycle
  // C's useSearchParams.mockReturnValue(new URLSearchParams("filter=..."))
  // would leak into every later test in this file. Re-arm both defaults
  // after every test, regardless of what that test changed them to.
  hasSupabaseBrowserConfig.mockReturnValue(true);
  useSearchParams.mockReturnValue(new URLSearchParams());
  vi.useRealTimers();
});

describe("LibraryPage attention filter", () => {
  it("filters by hasActionableTarget, not state; the counter matches; fetches detail only for the filtered subset", async () => {
    listContentSummaries.mockResolvedValue([
      summary("a", "DRAFT", false),
      summary("b", "REVIEW", true),
    ]);
    getContentRecord.mockResolvedValue({
      // Corrección ronda 2 del plan review: la tarjeta renderizada lee
      // record.content.service/.niche (mismo patrón que
      // review/page.tsx:100) — sin estos campos, .replaceAll("_", " ")
      // sobre undefined tumba el test con un TypeError, no con la
      // aserción que se está probando.
      content: { id: "b", state: "REVIEW", service: "bot_whatsapp", niche: "clinicas" },
      targets: [{ id: "target-1", contentItemId: "b", platform: "FACEBOOK", status: "PENDING_REVIEW" }],
      drafts: [],
      auditEvents: [],
      publicationResults: [],
    });

    const user = userEvent.setup();
    render(<LibraryPage />);

    await waitFor(() => expect(listContentSummaries).toHaveBeenCalledTimes(1));
    expect(getContentRecord).not.toHaveBeenCalled();
    // Corrección ronda 1 del plan review: el contador "por revisar" debe
    // reflejar hasActionableTarget (1 de los 2 items), no
    // attentionStates.includes(state) (que daría un número distinto: 2,
    // porque "DRAFT" también estaba en la lista vieja de estados).
    expect(screen.getByText("1")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Por revisar" }));

    await waitFor(() => expect(getContentRecord).toHaveBeenCalledTimes(1));
    expect(getContentRecord).toHaveBeenCalledWith("b");
  });

  it("shows a visible per-card error for an id whose detail fetch fails, without hiding the rest (recomendación ronda 3 del plan review)", async () => {
    listContentSummaries.mockResolvedValue([
      summary("b", "REVIEW", true),
      summary("c", "REVIEW", true),
    ]);
    getContentRecord.mockImplementation((id: string) =>
      id === "c"
        ? Promise.reject(new Error("boom"))
        : Promise.resolve({
            content: { id: "b", state: "REVIEW", service: "bot_whatsapp", niche: "clinicas" },
            targets: [{ id: "target-1", contentItemId: "b", platform: "FACEBOOK", status: "PENDING_REVIEW" }],
            drafts: [], auditEvents: [], publicationResults: [],
          }),
    );

    const user = userEvent.setup();
    render(<LibraryPage />);
    await user.click(screen.getByRole("tab", { name: "Por revisar" }));

    await waitFor(() => expect(getContentRecord).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Aprobar Facebook/i })).toBeInTheDocument();
  });
});

describe("LibraryPage polling", () => {
  it("polls the cheap list while any item is GENERATING, regardless of active filter", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    listContentSummaries
      .mockResolvedValueOnce([summary("a", "GENERATING", false)])
      .mockResolvedValueOnce([summary("a", "DRAFT", false)]);

    render(<LibraryPage />);
    await waitFor(() => expect(listContentSummaries).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(4000);
    await waitFor(() => expect(listContentSummaries).toHaveBeenCalledTimes(2));

    await vi.advanceTimersByTimeAsync(4000);
    expect(listContentSummaries).toHaveBeenCalledTimes(2);
  });
});

function demoDraft(id: string, state: string, targets: Array<{ id: string; status: string; platform?: "FACEBOOK" | "INSTAGRAM" }>) {
  return {
    content: { id, state, service: "bot_whatsapp", niche: "clinicas", contentType: "venta_directa", objective: "agenda_demo" },
    filename: "creativo.png", mimeType: "image/png", previewDataUrl: "data:image/png;base64,",
    visualAnalysis: { source: "local-demo" as const, summary: "", detectedClaims: [] },
    drafts: [], selectedDraftId: "d1", finalCopy: { headline: "", body: "", cta: "", hashtags: [] },
    warnings: [],
    targets: targets.map((target) => ({ contentItemId: id, platform: "FACEBOOK" as const, ...target })),
    publicationResults: [], auditEvents: [], updatedAt: "2026-09-14T00:00:00.000Z",
  };
}

describe("LibraryPage demo mode", () => {
  it("reads readDemoDrafts (not readDemoAssets), needs no second fetch, and links attention cards to /drafts/[id]", async () => {
    hasSupabaseBrowserConfig.mockReturnValue(false);
    readDemoDrafts.mockReturnValue([
      demoDraft("d1", "DRAFT", [{ id: "t1", status: "PENDING_REVIEW" }]),
      demoDraft("d2", "REVIEW", [{ id: "t2", status: "PENDING_REVIEW" }]),
    ]);

    const user = userEvent.setup();
    render(<LibraryPage />);
    await waitFor(() => expect(readDemoDrafts).toHaveBeenCalled());

    await user.click(screen.getByRole("tab", { name: "Por revisar" }));

    expect(getContentRecord).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: /Abrir/i })).toHaveAttribute("href", "/drafts/d2");
  });

  it("removes the demo card from the attention filter and decrements the counter after approving its last target", async () => {
    hasSupabaseBrowserConfig.mockReturnValue(false);
    const draftBeforeApproval = demoDraft("d1", "REVIEW", [{ id: "t1", status: "PENDING_REVIEW" }]);
    const draftAfterApproval = demoDraft("d1", "APPROVED", [{ id: "t1", status: "APPROVED" }]);
    readDemoDrafts
      .mockReturnValueOnce([draftBeforeApproval])
      .mockReturnValue([draftAfterApproval]);
    approveDemoTarget.mockReturnValue(draftAfterApproval);

    const user = userEvent.setup();
    render(<LibraryPage />);
    await user.click(screen.getByRole("tab", { name: "Por revisar" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Aprobar Facebook/i })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /Aprobar Facebook/i }));

    expect(approveDemoTarget).toHaveBeenCalledWith("d1", "t1");
    await waitFor(() => expect(readDemoDrafts).toHaveBeenCalledTimes(2));
    expect(screen.getByText("por revisar").parentElement).toHaveTextContent("0");
  });
});

describe("LibraryPage query param", () => {
  it("opens directly on the attention filter when ?filter=attention", async () => {
    useSearchParams.mockReturnValue(new URLSearchParams("filter=attention"));
    listContentSummaries.mockResolvedValue([summary("a", "REVIEW", true)]);
    getContentRecord.mockResolvedValue({
      content: { id: "a", state: "REVIEW", service: "bot_whatsapp", niche: "clinicas" },
      targets: [{ id: "t1", contentItemId: "a", platform: "FACEBOOK", status: "PENDING_REVIEW" }],
      drafts: [], auditEvents: [], publicationResults: [],
    });

    render(<LibraryPage />);

    expect(screen.getByRole("tab", { name: "Por revisar" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(getContentRecord).toHaveBeenCalledWith("a"));
  });
});

describe("LibraryPage sync after approve", () => {
  it("removes the card from the attention filter and decrements the counter after approving its last actionable target", async () => {
    listContentSummaries
      .mockResolvedValueOnce([summary("a", "REVIEW", true)])
      .mockResolvedValueOnce([summary("a", "REVIEW", false)]);
    getContentRecord.mockResolvedValue({
      content: { id: "a", state: "REVIEW", service: "bot_whatsapp", niche: "clinicas" },
      targets: [{ id: "t1", contentItemId: "a", platform: "FACEBOOK", status: "PENDING_REVIEW" }],
      drafts: [{ headline: "h", body: "b", cta: "c", hashtags: [], id: "d1", contentItemId: "a", visualAnalysis: {}, createdAt: "2026-09-14T00:00:00.000Z" }],
      auditEvents: [], publicationResults: [],
    });
    approveContentTarget.mockResolvedValue({ id: "t1", contentItemId: "a", platform: "FACEBOOK", status: "APPROVED" });

    const user = userEvent.setup();
    render(<LibraryPage />);
    await user.click(screen.getByRole("tab", { name: "Por revisar" }));
    await waitFor(() => expect(getContentRecord).toHaveBeenCalledWith("a"));

    await user.click(screen.getByRole("button", { name: /Aprobar Facebook/i }));

    await waitFor(() => expect(listContentSummaries).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("h")).not.toBeInTheDocument());
    expect(screen.getByText("por revisar").parentElement).toHaveTextContent("0");
  });
});
