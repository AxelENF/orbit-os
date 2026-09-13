/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PublicationTargets } from "@/components/content/publication-targets";
import type { PublicationTarget } from "@/lib/content/repository";

const pendingTargets: PublicationTarget[] = [
  {
    id: "facebook-target-id",
    contentItemId: "content-item-id",
    platform: "FACEBOOK",
    status: "PENDING_REVIEW",
  },
  {
    id: "instagram-target-id",
    contentItemId: "content-item-id",
    platform: "INSTAGRAM",
    status: "PENDING_REVIEW",
  },
];

describe("PublicationTargets", () => {
  afterEach(() => cleanup());

  it("approves Facebook without approving Instagram", async () => {
    const onApprove = vi.fn().mockResolvedValue({
      ...pendingTargets[0],
      status: "APPROVED",
    });

    render(<PublicationTargets targets={pendingTargets} onApprove={onApprove} />);

    fireEvent.click(screen.getByRole("button", { name: "Aprobar Facebook" }));

    expect(onApprove).toHaveBeenCalledWith("facebook-target-id");
    expect(screen.getByText("Instagram: pendiente de revisión")).toBeInTheDocument();
    expect(await screen.findByText("Facebook: aprobado")).toBeInTheDocument();
  });

  it("keeps the second platform pending until its own approval", async () => {
    const onApprove = vi.fn().mockResolvedValue({
      ...pendingTargets[0],
      status: "APPROVED",
    });

    render(<PublicationTargets targets={pendingTargets} onApprove={onApprove} />);

    fireEvent.click(screen.getByRole("button", { name: "Aprobar Facebook" }));

    expect(await screen.findByRole("button", { name: "Aprobar Instagram" })).toBeEnabled();
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("keeps a target pending and offers a retry when approval fails", async () => {
    const onApprove = vi.fn().mockRejectedValue(new Error("approval unavailable"));

    render(<PublicationTargets targets={pendingTargets} onApprove={onApprove} />);

    fireEvent.click(screen.getByRole("button", { name: "Aprobar Facebook" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo registrar la aprobación de Facebook");
    expect(screen.getByText("Facebook: pendiente de revisión")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aprobar Facebook" })).toBeEnabled();
  });

  it("offers retry only for an errored target and marks it approved after success", async () => {
    const erroredTargets: PublicationTarget[] = [{
      ...pendingTargets[0],
      status: "ERROR",
      lastError: "Meta token expired",
    }];
    const onRetry = vi.fn().mockResolvedValue({ ...erroredTargets[0], status: "APPROVED" });

    render(<PublicationTargets targets={erroredTargets} onApprove={vi.fn()} onRetry={onRetry} />);

    expect(screen.getByRole("button", { name: "Reintentar" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Aprobar Facebook" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));

    expect(onRetry).toHaveBeenCalledWith("facebook-target-id");
    expect(await screen.findByText("Facebook: aprobado")).toBeInTheDocument();
  });

  it("explains an empty target list without creating an approval", () => {
    render(<PublicationTargets targets={[]} onApprove={vi.fn()} />);

    expect(screen.getByText("No hay destinos para revisar.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Aprobar/ })).not.toBeInTheDocument();
  });
});
