import { describe, expect, it, vi } from "vitest";

import {
  publishToFacebook,
  publishToInstagram,
  type FacebookPublishInput,
} from "@/lib/integrations/meta-graph-client";

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

function instagramInputWithAssets(assets: FacebookPublishInput["assets"]): FacebookPublishInput & { igUserId: string } {
  return {
    ...inputWithAssets(assets),
    igUserId: "ig-456",
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

describe("publishToInstagram", () => {
  it("imagen única: crea contenedor, hace poll hasta listo, publica, obtiene permalink", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: "container-1" }))
      .mockResolvedValueOnce(jsonResponse({ status_code: "FINISHED" }))
      .mockResolvedValueOnce(jsonResponse({ id: "media-1" }))
      .mockResolvedValueOnce(jsonResponse({ permalink: "https://instagram.com/p/media-1" }));

    const result = await publishToInstagram(
      instagramInputWithAssets([{ signedUrl: "https://cdn.example/one.png", position: 1 }]),
      fetchFn,
    );

    const creation = requestDetails(fetchFn, 0);
    const poll = requestDetails(fetchFn, 1);
    const publish = requestDetails(fetchFn, 2);
    const permalink = requestDetails(fetchFn, 3);
    expect(creation.url.pathname).toBe("/v21.0/ig-456/media");
    expect(creation.init.method).toBe("POST");
    expect(creation.form?.get("image_url")).toBe("https://cdn.example/one.png");
    expect(creation.form?.get("caption")).toBe("Una publicación de prueba.");
    expect(creation.form?.get("access_token")).toBe("page-token");
    expect(poll.url.pathname).toBe("/v21.0/container-1");
    expect(poll.url.searchParams.get("fields")).toBe("status_code");
    expect(poll.url.searchParams.get("access_token")).toBe("page-token");
    expect(poll.init.method).toBe("GET");
    expect(publish.url.pathname).toBe("/v21.0/ig-456/media_publish");
    expect(publish.form?.get("creation_id")).toBe("container-1");
    expect(publish.form?.get("access_token")).toBe("page-token");
    expect(permalink.url.pathname).toBe("/v21.0/media-1");
    expect(permalink.url.searchParams.get("fields")).toBe("permalink");
    expect(permalink.url.searchParams.get("access_token")).toBe("page-token");
    expect(permalink.init.method).toBe("GET");
    expect(result.remotePostId).toBe("media-1");
    expect(result.remoteUrl).toBe("https://instagram.com/p/media-1");
    expect(result.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Number.isNaN(Date.parse(result.publishedAt))).toBe(false);
  });

  it("carrusel: crea contenedores hijo is_carousel_item=true en orden, contenedor padre CAROUSEL, poll, publish", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: "child-first" }))
      .mockResolvedValueOnce(jsonResponse({ id: "child-second" }))
      .mockResolvedValueOnce(jsonResponse({ id: "container-carousel" }))
      .mockResolvedValueOnce(jsonResponse({ status_code: "FINISHED" }))
      .mockResolvedValueOnce(jsonResponse({ id: "media-carousel" }))
      .mockResolvedValueOnce(jsonResponse({ permalink: "https://instagram.com/p/media-carousel" }));

    const result = await publishToInstagram(
      instagramInputWithAssets([
        { signedUrl: "https://cdn.example/second.png", position: 2 },
        { signedUrl: "https://cdn.example/first.png", position: 1 },
      ]),
      fetchFn,
    );

    const firstChild = requestDetails(fetchFn, 0);
    const secondChild = requestDetails(fetchFn, 1);
    const parent = requestDetails(fetchFn, 2);
    expect(firstChild.form?.get("image_url")).toBe("https://cdn.example/first.png");
    expect(firstChild.form?.get("is_carousel_item")).toBe("true");
    expect(firstChild.form?.get("access_token")).toBe("page-token");
    expect(secondChild.form?.get("image_url")).toBe("https://cdn.example/second.png");
    expect(secondChild.form?.get("is_carousel_item")).toBe("true");
    expect(parent.url.pathname).toBe("/v21.0/ig-456/media");
    expect(parent.form?.get("media_type")).toBe("CAROUSEL");
    expect(parent.form?.get("children")).toBe("child-first,child-second");
    expect(parent.form?.get("caption")).toBe("Una publicación de prueba.");
    expect(parent.form?.get("access_token")).toBe("page-token");
    expect(requestDetails(fetchFn, 3).url.pathname).toBe("/v21.0/container-carousel");
    expect(requestDetails(fetchFn, 4).form?.get("creation_id")).toBe("container-carousel");
    expect(result.remotePostId).toBe("media-carousel");
    expect(result.remoteUrl).toBe("https://instagram.com/p/media-carousel");
  });

  it("poll que nunca llega a listo en 60s -> MetaPublishError retryable=true (timeout de contenedor, no de red)", async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ id: "container-timeout" }))
        .mockImplementation(async () => jsonResponse({ status_code: "IN_PROGRESS" }));

      const promise = publishToInstagram(
        instagramInputWithAssets([{ signedUrl: "https://cdn.example/one.png", position: 1 }]),
        fetchFn,
      );
      const rejection = expect(promise).rejects.toMatchObject({
        name: "MetaPublishError",
        retryable: true,
        requiresReconnect: false,
      });

      await vi.advanceTimersByTimeAsync(60_000);

      await rejection;
      expect(fetchFn).toHaveBeenCalledTimes(31);
      expect(fetchFn.mock.calls[1]?.[0]).toContain("container-timeout?fields=status_code");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["HTTP 5xx", jsonResponse({ message: "Meta unavailable" }, 503), { retryable: true, requiresReconnect: false }],
    [
      "transient Meta error",
      jsonResponse({ error: { message: "Rate limit", code: 4, is_transient: true } }, 400),
      { retryable: true, requiresReconnect: false },
    ],
    [
      "token inválido",
      jsonResponse({ error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 } }, 400),
      { retryable: false, requiresReconnect: true },
    ],
    [
      "contenido rechazado por política",
      jsonResponse({ error: { message: "The content was rejected by policy.", code: 368 } }, 400),
      { retryable: false, requiresReconnect: false },
    ],
  ])("%s -> MetaPublishError con la misma clasificación que Facebook", async (_label, response, expected) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(
      publishToInstagram(
        instagramInputWithAssets([{ signedUrl: "https://cdn.example/one.png", position: 1 }]),
        fetchFn,
      ),
    ).rejects.toMatchObject({ name: "MetaPublishError", ...expected });
  });

  it("error de red sin respuesta HTTP -> MetaPublishError no reintentable sin reconexión", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new Error("network down"));

    await expect(
      publishToInstagram(
        instagramInputWithAssets([{ signedUrl: "https://cdn.example/one.png", position: 1 }]),
        fetchFn,
      ),
    ).rejects.toMatchObject({
      name: "MetaPublishError",
      retryable: false,
      requiresReconnect: false,
    });
  });
});
