# 01: Selecionar um usuário local para entrar no Hub

**What to build:** A pessoa abre o Hub, vê boas-vindas e disponibilidade, carrega e seleciona um usuário local existente pela experiência do Hub e entra numa página inicial mínima com o perfil ativo visível. Se a lista não puder ser carregada ou a seleção validada, a entrada permanece bloqueada, com explicação e opção de tentar novamente sem recarregar a página.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] A tela de entrada apresenta boas-vindas e disponibilidade da API do Hub.
- [x] A pessoa precisa escolher um usuário local existente carregado pela API do Hub antes de acessar a experiência inicial.
- [x] Uma seleção válida abre uma experiência inicial mínima com boas-vindas, perfil ativo e estado do Hub visíveis; nenhum catálogo de módulos é apresentado.
- [x] Falhas ao carregar perfis ou validar a seleção são explicadas e permitem nova tentativa sem recarregar a página; o acesso continua bloqueado até a validação.
- [x] Testes unitários, de integração/API e de navegador cobrem os critérios desta entrega.
- [x] Chamadas HTTP sem resposta terminam em tempo finito, mostram erro recuperável e permitem tentar novamente sem recarregar.
- [x] A API rejeita identificadores locais `.` e `..`, que não podem ser validados corretamente como segmentos de URL.
- [x] O frontend consome tipos gerados da especificação OpenAPI publicada pelo backend.

Consulte a [spec da Fase 1](../spec.md).

## Comments

- Implementado e verificado em `repos/pmo-hub` na branch `main`.
- Reaberto após revisão de código para tratar timeout, IDs de perfil inválidos e consumo tipado do contrato OpenAPI.
- Testes finais: `npm test` (frontend 4/4; API 6/6); `npm run test:e2e --workspace @pmo-hub/hub` (3/3); `npm run build`; `npm run lint`; build também passou com `HUB_LOCAL_USERS_FILE` apontando para arquivo inexistente. `git diff --check dbbb82f...86ef9c4` passou.
- Commits locais: `repos/pmo-hub`, branch `main`: `c0386eb` (estrutura npm); `30c3e1a` (fluxo inicial); `58189dd` (proteção da validação); `dbbb82f` (lint); `4ec5000` (timeout, IDs reservados e tipos OpenAPI); `86ef9c4` (geração OpenAPI independente de perfis locais).
- Revisão independente final: sem pendências materiais de spec. P3 preexistente: uma instalação isolada da API pode não incluir as ferramentas ESLint compartilhadas declaradas no workspace frontend.
