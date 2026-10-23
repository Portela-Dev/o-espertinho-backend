// appOrigin is escaped by the authorization route before interpolation.
export const extensionConnectPage = (appOrigin: string) => `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Conectar extensão — O Espertinho</title>
  <link rel="icon" type="image/png" href="/api/extension/auth/assets/icon.png">
  <link rel="stylesheet" href="/api/extension/auth/assets/connect.css">
  <script src="/api/extension/auth/connect.js" defer></script>
</head>
<body>
  <header><a class="brand" href="${appOrigin}" aria-label="O Espertinho — página inicial">O Espertinho<span>.</span></a></header>
  <main aria-labelledby="title">
    <section class="welcome" aria-label="O Espertinho">
      <span class="eyebrow">SEU CATÁLOGO, MAIS ESPERTO</span>
      <h2>Bons achados.<br><span>Uma só conexão.</span></h2>
      <p>Conecte sua conta à extensão e continue cuidando dos seus achados.</p>
      <img src="/api/extension/auth/assets/mascot.png" alt="Mascote do Espertinho piscando e apontando para você" width="384" height="384">
    </section>
    <section class="connection" aria-labelledby="title">
      <span class="eyebrow">EXTENSÃO DO CHROME</span>
      <h1 id="title">Vamos conectar<br>sua conta?</h1>
      <p class="intro">Autorize somente se você iniciou esta conexão na extensão O Espertinho.</p>
      <p id="status" role="status" aria-live="polite" aria-atomic="true" data-state="info">Verificando sua conta…</p>
      <a class="button outline" id="site-login" href="${appOrigin}" target="_blank" rel="noopener noreferrer">Entrar no O Espertinho com Google <span aria-hidden="true">↗</span></a>
      <div class="actions">
        <button class="button primary" type="button" id="approve" disabled>Autorizar extensão</button>
        <button class="button secondary" type="button" id="reload">Verificar login novamente</button>
      </div>
      <p class="footnote">A conexão respeita as permissões do seu perfil no O Espertinho.</p>
    </section>
  </main>
  <footer>Um bom achado começa com uma boa escolha.</footer>
</body>
</html>`;
