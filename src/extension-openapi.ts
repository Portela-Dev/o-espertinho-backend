export function extensionApiPaths() {
  const paths: Record<string, unknown> = {};
  const operations = [
    [
      "post",
      "auth/start",
      "Iniciar pareamento com desafio SHA-256",
      { challenge: { type: "string", pattern: "^[a-f0-9]{64}$" } },
      "public",
    ],
    [
      "post",
      "auth/poll",
      "Trocar aprovação por tokens de sessão",
      { deviceCode: { type: "string" }, verifier: { type: "string" } },
      "public",
    ],
    [
      "post",
      "auth/approve",
      "Autorizar extensão com conta real e permissão affiliate_links",
      { code: { type: "string" } },
      "browser",
    ],
    [
      "post",
      "auth/refresh",
      "Renovar sessão com rotação do refresh token",
      { refreshToken: { type: "string" } },
      "public",
    ],
    ["post", "auth/logout", "Revogar sessão da extensão", {}, "extension"],
    ["get", "session", "Consultar conta e permissão atual", null, "extension"],
  ] as const;
  for (const [method, path, summary, properties, auth] of operations) {
    let security: Record<string, never[]>[] = [];
    if (auth === "extension") {
      security = [{ ExtensionBearer: [] }];
    } else if (auth === "browser") {
      security = [{ SessionCookie: [], XSRFToken: [] }];
    }
    paths["/extension/" + path] = {
      [method]: {
        operationId: "extension_" + method + "_" + path.replaceAll("/", "_"),
        tags: ["Extensão Chrome"],
        summary,
        description:
          "Autenticação real da extensão, disponível em produção. Exige origem/identificador coerentes, conta ativa e permissão affiliate_links. A aprovação pelo navegador usa sessão e XSRF.",
        security,
        parameters:
          auth === "browser"
            ? []
            : [
                {
                  name: "X-Espertinho-Extension-Id",
                  in: "header",
                  required: true,
                  schema: { type: "string", pattern: "^[a-p]{32}$" },
                },
              ],
        ...(properties && Object.keys(properties).length
          ? {
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties,
                      required: Object.keys(properties),
                    },
                  },
                },
              },
            }
          : {}),
        responses: {
          "200": { description: "Operação concluída." },
          ...(path === "auth/poll"
            ? { "202": { description: "Aguardando aprovação no navegador." } }
            : {}),
          "400": { description: "Contrato inválido." },
          "401": { description: "Sessão inválida ou expirada." },
          "403": { description: "Permissão, origem ou XSRF inválido." },
          "409": { description: "Reserva inválida." },
          "410": { description: "Pareamento expirado ou consumido." },
        },
      },
    };
  }
  return paths;
}
