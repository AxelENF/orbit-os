import { describe, expect, it, vi } from "vitest";
import { StorageApiError } from "@supabase/supabase-js";

import {
  createOrganizationLogoGetHandler,
  createOrganizationLogoPostHandler,
} from "@/app/api/organizations/[id]/logo/route";

const organizationId = "1e62a32f-64c2-4da4-bad0-2837baad7812";
const pngSignature = Uint8Array.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0,
  0,
  0,
  0,
]);

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function context() {
  return { params: Promise.resolve({ id: organizationId }) };
}

describe("GET /api/organizations/[id]/logo", () => {
  it("streams the logo bytes with image/png content-type when it exists", async () => {
    const download = vi.fn().mockResolvedValue({
      data: new Blob([asArrayBuffer(pngSignature)], { type: "image/png" }),
      error: null,
    });
    const handler = createOrganizationLogoGetHandler({
      getSession: async () => ({ userId: "user-1" }),
      getMembership: async () => ({ role: "editor" }),
      download,
    });
    const response = await handler(
      new Request("http://localhost/api/organizations/x/logo"),
      context(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(download).toHaveBeenCalledWith(`${organizationId}/logo.png`);
  });

  it("responds 404 LOGO_NOT_CONFIGURED when the object doesn't exist (StorageApiError NoSuchKey)", async () => {
    const download = vi.fn().mockResolvedValue({
      data: null,
      error: new StorageApiError(
        "not found",
        404,
        "not_found",
        "storage",
        "NoSuchKey",
      ),
    });
    const handler = createOrganizationLogoGetHandler({
      getSession: async () => ({ userId: "user-1" }),
      getMembership: async () => ({ role: "viewer" }),
      download,
    });
    const response = await handler(
      new Request("http://localhost/api/organizations/x/logo"),
      context(),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "LOGO_NOT_CONFIGURED",
    });
  });

  it("responds 503 LOGO_LOOKUP_FAILED for a real Storage error", async () => {
    const download = vi.fn().mockResolvedValue({
      data: null,
      error: new StorageApiError(
        "boom",
        500,
        "internal_error",
        "storage",
        "InternalError",
      ),
    });
    const handler = createOrganizationLogoGetHandler({
      getSession: async () => ({ userId: "user-1" }),
      getMembership: async () => ({ role: "viewer" }),
      download,
    });
    const response = await handler(
      new Request("http://localhost/api/organizations/x/logo"),
      context(),
    );
    expect(response.status).toBe(503);
  });

  it("does not allow reading a different organization's logo", async () => {
    const handler = createOrganizationLogoGetHandler({
      getSession: async () => ({ userId: "user-1" }),
      getMembership: async () => null,
      download: vi.fn(),
    });
    const response = await handler(
      new Request("http://localhost/api/organizations/x/logo"),
      context(),
    );
    expect(response.status).toBe(404);
  });
});

describe("POST /api/organizations/[id]/logo", () => {
  function formDataRequest(bytes: Uint8Array, filename = "logo.png") {
    const formData = new FormData();
    formData.set(
      "logo",
      new File([asArrayBuffer(bytes)], filename, { type: "image/png" }),
    );
    return new Request("http://localhost/api/organizations/x/logo", {
      method: "POST",
      body: formData,
    });
  }

  it("uploads with upsert, forcing contentType image/png regardless of client-supplied type", async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const handler = createOrganizationLogoPostHandler({
      getSession: async () => ({ userId: "user-1" }),
      getMembership: async () => ({ role: "owner" }),
      upload,
    });
    const response = await handler(formDataRequest(pngSignature), context());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(upload).toHaveBeenCalledWith(
      `${organizationId}/logo.png`,
      expect.anything(),
      expect.objectContaining({ upsert: true, contentType: "image/png" }),
    );
  });

  it("rejects a non-owner with 403", async () => {
    const handler = createOrganizationLogoPostHandler({
      getSession: async () => ({ userId: "user-1" }),
      getMembership: async () => ({ role: "editor" }),
      upload: vi.fn(),
    });
    const response = await handler(formDataRequest(pngSignature), context());
    expect(response.status).toBe(403);
  });

  it("rejects a file whose bytes aren't a real PNG, regardless of declared Content-Type", async () => {
    const notPng = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
    const handler = createOrganizationLogoPostHandler({
      getSession: async () => ({ userId: "user-1" }),
      getMembership: async () => ({ role: "owner" }),
      upload: vi.fn(),
    });
    const response = await handler(formDataRequest(notPng), context());
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "INVALID_LOGO_FORMAT",
    });
  });

  it("accepts real PNG bytes even when the client falsely declares a different Content-Type", async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const handler = createOrganizationLogoPostHandler({
      getSession: async () => ({ userId: "user-1" }),
      getMembership: async () => ({ role: "owner" }),
      upload,
    });
    const formData = new FormData();
    formData.set(
      "logo",
      new File([asArrayBuffer(pngSignature)], "logo.png", {
        type: "image/jpeg",
      }),
    );
    const request = new Request("http://localhost/api/organizations/x/logo", {
      method: "POST",
      body: formData,
    });

    const response = await handler(request, context());

    expect(response.status).toBe(200);
    expect(upload).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ contentType: "image/png" }),
    );
  });

  it("returns 503 ORGANIZATION_LOOKUP_FAILED (not 404) when the membership lookup itself throws", async () => {
    const handler = createOrganizationLogoPostHandler({
      getSession: async () => ({ userId: "user-1" }),
      getMembership: async () => {
        throw new Error("connection reset");
      },
      upload: vi.fn(),
    });
    const response = await handler(formDataRequest(pngSignature), context());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "ORGANIZATION_LOOKUP_FAILED",
    });
  });

  it("returns 400 INVALID_REQUEST when multipart formData parsing throws", async () => {
    const handler = createOrganizationLogoPostHandler({
      getSession: async () => ({ userId: "user-1" }),
      getMembership: async () => ({ role: "owner" }),
      upload: vi.fn(),
    });
    const request = new Request("http://localhost/api/organizations/x/logo", {
      method: "POST",
    });
    vi.spyOn(request, "formData").mockRejectedValue(
      new Error("malformed multipart"),
    );

    const response = await handler(request, context());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "INVALID_REQUEST",
    });
  });

  it("rejects a file over 2MB with 413", async () => {
    const tooLarge = new Uint8Array(2 * 1024 * 1024 + 1);
    tooLarge.set(pngSignature);
    const handler = createOrganizationLogoPostHandler({
      getSession: async () => ({ userId: "user-1" }),
      getMembership: async () => ({ role: "owner" }),
      upload: vi.fn(),
    });
    const response = await handler(formDataRequest(tooLarge), context());
    expect(response.status).toBe(413);
  });
});
