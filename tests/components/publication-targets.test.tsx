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

  it("approves Facebook without approving Instagram", () => {
    const onApprove = vi.fn();

    render(<PublicationTargets targets={pendingTargets} onApprove={onApprove} />);

    fireEvent.click(screen.getByRole("button", { name: "Aprobar Facebook" }));

    expect(onApprove).toHaveBeenCalledWith("facebook-target-id");
    expect(screen.getByText("Instagram: pendiente de revisión")).toBeInTheDocument();
    expect(screen.getByText("Facebook: aprobado")).toBeInTheDocument();
  });

  it("keeps the second platform pending until its own approval", () => {
    const onApprove = vi.fn();

    render(<PublicationTargets targets={pendingTargets} onApprove={onApprove} />);

    fireEvent.click(screen.getByRole("button", { name: "Aprobar Facebook" }));

    expect(screen.getByRole("button", { name: "Aprobar Instagram" })).toBeEnabled();
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("explains an empty target list without creating an approval", () => {
    render(<PublicationTargets targets={[]} onApprove={vi.fn()} />);

    expect(screen.getByText("No hay destinos para revisar.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Aprobar/ })).not.toBeInTheDocument();
  });
});
