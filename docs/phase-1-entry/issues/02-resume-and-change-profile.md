# 02: Retomar e trocar o perfil local

**What to build:** O Hub lembra a última seleção neste navegador, valida o usuário local pela API ao abrir e oferece um controle visível para trocar de perfil. Se o perfil salvo não existir mais, a seleção é removida, a pessoa recebe uma explicação e precisa escolher outro perfil antes de continuar.

**Blocked by:** 01 — Selecionar um usuário local para entrar no Hub

**Status:** resolved

**Repository:** [Zhong-star/pmo-hub](https://github.com/Zhong-star/pmo-hub) (`apps/hub/`)

- [x] O navegador guarda apenas o identificador do usuário local selecionado, sem expiração nesta fase.
- [x] Ao reabrir, o Hub valida pela API que o usuário salvo ainda existe antes de liberar a experiência.
- [x] Se o perfil salvo não existir, o Hub limpa o identificador, explica a situação e solicita nova seleção.
- [x] Se a API não puder validar o perfil salvo, o Hub bloqueia a experiência, explica o problema e oferece nova tentativa sem recarregar a página.
- [x] Um controle visível inicia a troca; a pessoa retorna à entrada e só continua após selecionar outro usuário local válido.
- [x] Testes unitários, de integração/API e de navegador cobrem os critérios desta entrega.

Consulte a [spec da Fase 1](../spec.md).

## Comments

- Implementado e verificado em `repos/pmo-hub`, branch `main`, commit `95e20ae6946e8d2a4fc663582baeb64446103c89`.
- Código: [commit inicial](https://github.com/Zhong-star/pmo-hub/commit/95e20ae6946e8d2a4fc663582baeb64446103c89) e [correções da revisão](https://github.com/Zhong-star/pmo-hub/commit/aa594f0ba4f41493ad88a03b8ecdb7ae78063a46).
- Testes: `npm test` (8 frontend, 6 API); `npm run test:e2e --workspace @pmo-hub/hub` (6 navegador); `npm run lint`; `npm run typecheck`; `npm run build` — todos passaram.
- A troca mantém o identificador salvo até a validação do novo perfil; seleção repetida do mesmo perfil é bloqueada. A leitura e escrita de `localStorage` são best-effort.
- Revisão corrigida em `repos/pmo-hub`, branch `main`, commit `aa594f0ba4f41493ad88a03b8ecdb7ae78063a46`. Verificação final: `npm test` (9 frontend, 6 API); `npm run test:e2e --workspace @pmo-hub/hub` (7 navegador); `npm run lint`; `npm run typecheck`; `npm run build` — todos passaram.
- A retomada automática ocorre somente na abertura; erros de perfil removido não geram alerta de seleção manual; disponibilidade reflete falha da validação necessária. Os testes confirmam retry após falha e remoção do perfil, troca validada, proteção de armazenamento e ausência de retomada automática após falha manual.
