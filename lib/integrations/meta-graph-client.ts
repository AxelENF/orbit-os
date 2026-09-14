import { MetaPublishError } from "@/lib/integrations/meta-publish-error";

export const GRAPH_API_VERSION = "v21.0";
export const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

const GRAPH_API_TIMEOUT_MS = 30_000;
const TRANSIENT_ERROR_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);
const TOKEN_ERROR_SUBCODES = new Set([458, 459, 460, 463, 464, 467]);

type GraphApiParams = Record<string, string | number | boolean>;
type GraphApiResponse = Record<string, unknown>;
type GraphApiError = {
  message?: unknown;
  type?: unknown;
  code?: unknown;
  error_subcode?: unknown;
  is_transient?: unknown;
};

export type FacebookPublishInput = {
  pageId: string;
  pageAccessToken: string;
  caption: string;
  assets: Array<{ signedUrl: string; position: number }>;
};

export type MetaPublishResult = {
  remotePostId: string;
  remoteUrl: string;
  publishedAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function describeGraphError(error: GraphApiError | undefined, status: number): MetaPublishError {
  const code = numberValue(error?.code);
  const subcode = numberValue(error?.error_subcode);
  const message = stringValue(error?.message) ?? `HTTP ${status}`;
  const normalizedMessage = message.toLowerCase();
  const isTokenError =
    code === 190 ||
    (subcode !== undefined && TOKEN_ERROR_SUBCODES.has(subcode)) ||
    normalizedMessage.includes("invalid oauth access token") ||
    normalizedMessage.includes("access token has expired") ||
    normalizedMessage.includes("access token is invalid") ||
    normalizedMessage.includes("token has been revoked");
  const isTransientError =
    status === 429 ||
    status >= 500 ||
    error?.is_transient === true ||
    (code !== undefined && TRANSIENT_ERROR_CODES.has(code)) ||
    normalizedMessage.includes("rate limit") ||
    normalizedMessage.includes("temporarily unavailable");

  if (isTokenError) {
    return new MetaPublishError(`Meta rechazó el token de acceso: ${message}`, false, true);
  }
  if (isTransientError) {
    return new MetaPublishError(`Meta Graph API respondió con un error transitorio: ${message}`, true, false);
  }
  return new MetaPublishError(`Meta rechazó la publicación: ${message}`, false, false);
}

function invalidResponse(message: string): MetaPublishError {
  return new MetaPublishError(message, false, false);
}

export async function callGraphApi(
  fetchFn: typeof fetch,
  path: string,
  params: GraphApiParams | null = null,
  method: "GET" | "POST" = "POST",
): Promise<GraphApiResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GRAPH_API_TIMEOUT_MS);
  let url: string | URL = `${GRAPH_API_BASE}/${path.replace(/^\/+/, "")}`;
  if (method === "GET" && params) {
    const parsedUrl = new URL(url);
    for (const [key, value] of Object.entries(params)) parsedUrl.searchParams.set(key, String(value));
    url = parsedUrl.toString();
  }
  const headers: HeadersInit = { accept: "application/json" };
  const request: RequestInit = { method, headers, signal: controller.signal };

  if (method !== "GET" && params) {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) body.set(key, String(value));
    headers["content-type"] = "application/x-www-form-urlencoded";
    request.body = body;
  }

  try {
    let response: Response;
    try {
      response = await fetchFn(url, request);
    } catch {
      throw invalidResponse("No se pudo confirmar la respuesta de Meta por un error de red o timeout.");
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw response.ok
        ? invalidResponse("Meta devolvió una respuesta JSON inválida.")
        : describeGraphError(undefined, response.status);
    }

    const graphError = isRecord(payload) && payload.error !== undefined ? payload.error : undefined;
    if (graphError !== undefined || !response.ok) {
      throw describeGraphError(isRecord(graphError) ? graphError : undefined, response.status);
    }
    if (!isRecord(payload)) {
      throw invalidResponse("Meta devolvió una respuesta con formato inválido.");
    }
    return payload;
  } catch (error) {
    if (error instanceof MetaPublishError) throw error;
    throw invalidResponse("No se pudo confirmar la respuesta de Meta por un error de red o timeout.");
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkTokenHealth(
  token: string,
  appToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const response = await callGraphApi(
    fetchFn,
    "debug_token",
    { input_token: token, access_token: appToken },
    "GET",
  );
  const data = isRecord(response.data) ? response.data : null;
  if (data?.is_valid !== true) {
    throw new MetaPublishError(
      "Meta reportó que el token de acceso no es válido.",
      false,
      true,
    );
  }
}

function requiredString(response: GraphApiResponse, key: string, message: string): string {
  const value = stringValue(response[key]);
  if (!value) throw invalidResponse(message);
  return value;
}

export async function publishToFacebook(
  input: FacebookPublishInput,
  fetchFn: typeof fetch = fetch,
): Promise<MetaPublishResult> {
  const sorted = [...input.assets].sort((a, b) => a.position - b.position);
  if (sorted.length === 0) {
    throw invalidResponse("Meta no puede publicar sin imágenes.");
  }

  let postId: string;
  if (sorted.length === 1) {
    const response = await callGraphApi(fetchFn, `${input.pageId}/photos`, {
      url: sorted[0]!.signedUrl,
      caption: input.caption,
      published: "true",
      access_token: input.pageAccessToken,
    });
    postId =
      stringValue(response.post_id) ??
      requiredString(response, "id", "Meta no devolvió el ID de la publicación.");
  } else {
    const mediaFbids: string[] = [];
    for (const asset of sorted) {
      const photo = await callGraphApi(fetchFn, `${input.pageId}/photos`, {
        url: asset.signedUrl,
        published: "false",
        access_token: input.pageAccessToken,
      });
      mediaFbids.push(requiredString(photo, "id", "Meta no devolvió el ID de la foto del carrusel."));
    }
    const post = await callGraphApi(fetchFn, `${input.pageId}/feed`, {
      message: input.caption,
      attached_media: JSON.stringify(mediaFbids.map((id) => ({ media_fbid: id }))),
      access_token: input.pageAccessToken,
    });
    postId = requiredString(post, "id", "Meta no devolvió el ID del carrusel.");
  }

  const permalink = await callGraphApi(
    fetchFn,
    `${postId}?fields=permalink_url&access_token=${encodeURIComponent(input.pageAccessToken)}`,
    null,
    "GET",
  );
  const remoteUrl = requiredString(permalink, "permalink_url", "Meta no devolvió el enlace permanente.");
  return { remotePostId: postId, remoteUrl, publishedAt: new Date().toISOString() };
}

async function pollContainerUntilReady(
  fetchFn: typeof fetch,
  containerId: string,
  accessToken: string,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const status = await callGraphApi(
      fetchFn,
      `${containerId}?fields=status_code&access_token=${encodeURIComponent(accessToken)}`,
      null,
      "GET",
    );
    if (status.status_code === "FINISHED") return;
    if (status.status_code === "ERROR") {
      throw new MetaPublishError("Instagram no pudo procesar el contenedor de medios.", false, false);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new MetaPublishError("Timeout esperando que Instagram procese el contenedor.", true, false);
}

export async function publishToInstagram(
  input: FacebookPublishInput & { igUserId: string },
  fetchFn: typeof fetch = fetch,
): Promise<MetaPublishResult> {
  const sorted = [...input.assets].sort((a, b) => a.position - b.position);
  if (sorted.length === 0) {
    throw invalidResponse("Meta no puede publicar sin imágenes.");
  }

  let creationId: string;
  if (sorted.length === 1) {
    const container = await callGraphApi(fetchFn, `${input.igUserId}/media`, {
      image_url: sorted[0]!.signedUrl,
      caption: input.caption,
      access_token: input.pageAccessToken,
    });
    creationId = requiredString(container, "id", "Meta no devolvió el ID del contenedor de Instagram.");
  } else {
    const childIds: string[] = [];
    for (const asset of sorted) {
      const child = await callGraphApi(fetchFn, `${input.igUserId}/media`, {
        image_url: asset.signedUrl,
        is_carousel_item: "true",
        access_token: input.pageAccessToken,
      });
      childIds.push(requiredString(child, "id", "Meta no devolvió el ID del contenedor hijo de Instagram."));
    }
    const parent = await callGraphApi(fetchFn, `${input.igUserId}/media`, {
      media_type: "CAROUSEL",
      children: childIds.join(","),
      caption: input.caption,
      access_token: input.pageAccessToken,
    });
    creationId = requiredString(parent, "id", "Meta no devolvió el ID del contenedor de carrusel de Instagram.");
  }

  await pollContainerUntilReady(fetchFn, creationId, input.pageAccessToken);
  const published = await callGraphApi(fetchFn, `${input.igUserId}/media_publish`, {
    creation_id: creationId,
    access_token: input.pageAccessToken,
  });
  const mediaId = requiredString(published, "id", "Meta no devolvió el ID de la publicación de Instagram.");
  const permalink = await callGraphApi(
    fetchFn,
    `${mediaId}?fields=permalink&access_token=${encodeURIComponent(input.pageAccessToken)}`,
    null,
    "GET",
  );
  const remoteUrl = requiredString(permalink, "permalink", "Meta no devolvió el enlace permanente de Instagram.");
  return { remotePostId: mediaId, remoteUrl, publishedAt: new Date().toISOString() };
}
