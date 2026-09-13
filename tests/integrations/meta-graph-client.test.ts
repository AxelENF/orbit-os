import { describe, expect, it, vi } from "vitest";

import { publishToFacebook, type FacebookPublishInput } from "@/lib/integrations/meta-graph-client";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function inputWithAssets(assets: FacebookPublishInput["assets"]): FacebookPublishInput {
  return {
    pageId: "page-123",
    pageAccessToken: "page-token",
    caption: "Una publicación de prueba.",
    assets,
  };
}

function requestDetails(fetchFn: ReturnType<typeof vi.fn<typeof fetch>>, index: number) {
  const [request, init] = fetchFn.mock.calls[index] as [RequestInfo | URL, RequestInit];
  return {
    url: new URL(String(request)),
    init,
    form: init.body ? new URLSearchParams(String(init.body)) : null,
  };
}

describe("publishToFacebook", () => {
  it("imagen única: POST a photos con url/caption/published=true, luego GET permalink_url", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ post_id: "post-1" }))
      .mockResolvedValueOnce(jsonResponse({ permalink_url: "https://facebook.com/post-1" }));

    const result = await publishToFacebook(
      inputWithAssets([{ signedUrl: "https://cdn.example/one.png", position: 1 }]),
      fetchFn,
    );

    const upload = requestDetails(fetchFn, 0);
    const permalink = requestDetails(fetchFn, 1);
    expect(upload.url.pathname).toBe("/v21.0/page-123/photos");
    expect(upload.init.method).toBe("POST");
    expect(upload.form?.get("url")).toBe("https://cdn.example/one.png");
    expect(upload.form?.get("caption")).toBe("Una publicación de prueba.");
    expect(upload.form?.get("published")).toBe("true");
    expect(upload.form?.get("access_token")).toBe("page-token");
    expect(permalink.url.pathname).toBe("/v21.0/post-1");
    expect(permalink.url.searchParams.get("fields")).toBe("permalink_url");
    expect(permalink.url.searchParams.get("access_token")).toBe("page-token");
    expect(permalink.init.method).toBe("GET");
    expect(result.remotePostId).toBe("post-1");
    expect(result.remoteUrl).toBe("https://facebook.com/post-1");
    expect(result.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Number.isNaN(Date.parse(result.publishedAt))).toBe(false);
  });

  it("carrusel: sube cada foto no publicada y conserva el orden de position en attached_media", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: "media-first" }))
      .mockResolvedValueOnce(jsonResponse({ id: "media-second" }))
      .mockResolvedValueOnce(jsonResponse({ id: "post-carousel" }))
      .mockResolvedValueOnce(jsonResponse({ permalink_url: "https://facebook.com/post-carousel" }));

    const result = await publishToFacebook(
      inputWithAssets([
        { signedUrl: "https://cdn.example/second.png", position: 2 },
        { signedUrl: "https://cdn.example/first.png", position: 1 },
      ]),
      fetchFn,
    );

    const firstUpload = requestDetails(fetchFn, 0);
    const secondUpload = requestDetails(fetchFn, 1);
    const feed = requestDetails(fetchFn, 2);
    expect(firstUpload.url.pathname).toBe("/v21.0/page-123/photos");
    expect(firstUpload.form?.get("url")).toBe("https://cdn.example/first.png");
    expect(firstUpload.form?.get("published")).toBe("false");
    expect(secondUpload.form?.get("url")).toBe("https://cdn.example/second.png");
    expect(secondUpload.form?.get("published")).toBe("false");
    expect(feed.url.pathname).toBe("/v21.0/page-123/feed");
    expect(feed.form?.get("message")).toBe("Una publicación de prueba.");
    expect(JSON.parse(feed.form?.get("attached_media") ?? "null")).toEqual([
      { media_fbid: "media-first" },
      { media_fbid: "media-second" },
    ]);
    expect(result.remotePostId).toBe("post-carousel");
    expect(result.remoteUrl).toBe("https://facebook.com/post-carousel");
    expect(result.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it.each([
    ["HTTP 5xx", jsonResponse({ message: "Meta unavailable" }, 503)],
    [
      "transient Meta error",
      jsonResponse({ error: { message: "Rate limit", code: 4, is_transient: true } }, 400),
    ],
  ])("%s -> MetaPublishError retryable=true", async (_label, response) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response);

    const promise = publishToFacebook(
      inputWithAssets([{ signedUrl: "https://cdn.example/one.png", position: 1 }]),
      fetchFn,
    );

    await expect(promise).rejects.toMatchObject({
      name: "MetaPublishError",
      retryable: true,
      requiresReconnect: false,
    });
  });

  it("token inválido -> MetaPublishError no reintentable que requiere reconexión", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 },
      }, 400),
    );

    await expect(
      publishToFacebook(
        inputWithAssets([{ signedUrl: "https://cdn.example/one.png", position: 1 }]),
        fetchFn,
      ),
    ).rejects.toMatchObject({
      name: "MetaPublishError",
      retryable: false,
      requiresReconnect: true,
    });
  });

  it("contenido rechazado por política -> MetaPublishError no reintentable sin reconexión", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        error: { message: "The content was rejected by policy.", code: 368 },
      }, 400),
    );

    await expect(
      publishToFacebook(
        inputWithAssets([{ signedUrl: "https://cdn.example/one.png", position: 1 }]),
        fetchFn,
      ),
    ).rejects.toMatchObject({
      name: "MetaPublishError",
      retryable: false,
      requiresReconnect: false,
    });
  });

  it("timeout de red sin respuesta HTTP -> MetaPublishError no reintentable sin reconexión", async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi.fn<typeof fetch>(async (_request, init) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      });

      const promise = publishToFacebook(
        inputWithAssets([{ signedUrl: "https://cdn.example/one.png", position: 1 }]),
        fetchFn,
      );
      const rejection = expect(promise).rejects.toMatchObject({
        name: "MetaPublishError",
        retryable: false,
        requiresReconnect: false,
      });
      await vi.advanceTimersByTimeAsync(60_000);

      await rejection;
      expect(fetchFn.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
    } finally {
      vi.useRealTimers();
    }
  });
});
