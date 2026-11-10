# PMO Hub

Código do PMO Hub em monorepo npm. Aplicações de navegador ficam em `apps/`; APIs e serviços ficam em `services/`.

## Planejamento e tickets

Specs e tickets de engenharia ficam versionados em `docs/<feature>/`, junto ao código que entregam. A Fase 1 de entrada do Hub está documentada em [`docs/phase-1-entry/`](docs/phase-1-entry/spec.md).

## Hub local

O Hub usa React/Vite em `apps/hub/` e a API NestJS em `services/hub-api/`. Execute `npm install` na raiz, depois inicie a API e a aplicação Hub pelos scripts dos workspaces.

Perfis locais de desenvolvimento são configurados pela API; consulte o README do serviço Hub API.
