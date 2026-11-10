# PMO Hub

Código do PMO Hub em monorepo npm. Aplicações de navegador ficam em `apps/`; APIs e serviços ficam em `services/`.

## Planejamento e tickets

Specs ficam em `docs/<feature>/`, junto ao código que descrevem. O acompanhamento de trabalho acontece como GitHub Issues. A Fase 1 do Hub está ligada às issues [#1](https://github.com/Zhong-star/pmo-hub/issues/1) e [#2](https://github.com/Zhong-star/pmo-hub/issues/2), com contexto adicional em [`docs/phase-1-entry/spec.md`](docs/phase-1-entry/spec.md).

## Hub local

O Hub usa React/Vite em `apps/hub/` e a API NestJS em `services/hub-api/`. Execute `npm install` na raiz, depois inicie a API e a aplicação Hub pelos scripts dos workspaces.

Perfis locais de desenvolvimento são configurados pela API; consulte o README do serviço Hub API.
