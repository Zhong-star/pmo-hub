# Fase 1 — Entrada da aplicação

**Status:** Tickets 01 e 02 implementados e verificados; Fase 1 concluída  
**Área:** Hub  
**Referência histórica:** [especificação da área Hub](../../planning/hub/.specs/features/phase-1-entry/spec.md)  
**Repositório/componente afetado:** `repos/pmo-hub` (`apps/hub/`, `services/hub-api/`)  
**Repositório GitHub:** [Zhong-star/pmo-hub](https://github.com/Zhong-star/pmo-hub)  
**Verificação:** `npm test` (9 testes frontend, 6 API); `npm run test:e2e --workspace @pmo-hub/hub` (7 testes de navegador); `npm run typecheck`; `npm run build`; `npm run lint` — todos passaram. O build também passou com `HUB_LOCAL_USERS_FILE` apontando para arquivo inexistente.  
**Commits:** `repos/pmo-hub`, branch `main`: `c0386eb`, `30c3e1a`, `58189dd`, `dbbb82f`, `4ec5000`, `86ef9c4`, `95e20ae6946e8d2a4fc663582baeb64446103c89`, `aa594f0ba4f41493ad88a03b8ecdb7ae78063a46`.
**Código da Fase 1 no GitHub:** [commits de implementação do ticket 02](https://github.com/Zhong-star/pmo-hub/compare/86ef9c4754902caf2753bf985c6f94374f2b9e16...aa594f0ba4f41493ad88a03b8ecdb7ae78063a46).
**GitHub Issues:** [#1 — Selecionar um usuário local](https://github.com/Zhong-star/pmo-hub/issues/1); [#2 — Retomar e trocar perfil](https://github.com/Zhong-star/pmo-hub/issues/2).

**Conclusão:** persistência, retomada e troca de perfil foram entregues no ticket 02. O ticket foi revisado, corrigido e verificado. A revisão final do ticket 01 não encontrou pendências materiais de spec.

## Objetivo

Permitir que uma pessoa entre na experiência local do PMO Hub selecionando um usuário local existente, com validação pela API do Hub e opção de retomar a última seleção neste navegador.

## Experiência

1. Ao abrir o Hub, a pessoa vê uma tela de entrada com boas-vindas e o estado de disponibilidade do Hub.
2. Sem perfil salvo, escolhe um usuário local cadastrado antes de acessar a experiência do Hub.
3. Com identificador salvo no navegador, o Hub valida pela API se o usuário local ainda existe antes de abrir a experiência inicial.
4. Se o perfil salvo não existir mais, o Hub limpa o identificador, explica o ocorrido e solicita outra seleção.
5. Após seleção validada, a pessoa acessa uma página inicial mínima que apresenta boas-vindas, o perfil ativo e o estado do Hub. O catálogo de módulos não faz parte desta fase.
6. A página oferece uma forma visível de trocar de perfil. A troca retorna à entrada e exige confirmar uma nova seleção antes de continuar.

## Regras e falhas

- O identificador do usuário local é guardado neste navegador e permanece até ser substituído ou o perfil deixar de existir; não há expiração nesta fase.
- A seleção de perfil depende apenas da API do Hub e do armazenamento local do navegador. A API valida existência; a seleção não é autenticação corporativa nem concessão de permissões.
- Se a API não puder carregar a lista de perfis ou validar o perfil salvo, bloquear o acesso à experiência do Hub, explicar o problema e oferecer nova tentativa sem recarregar a página.
- A tela informa a disponibilidade do Hub e sinaliza indisponibilidade de qualquer serviço estritamente necessário à seleção. Consulta de disponibilidade dos módulos é futura.
- Usuários locais são previamente preparados no ambiente; a interface não cadastra, edita nem atribui papéis.

## Fora de escopo

- Catálogo e abertura de módulos (Fase 2).
- Navegação comum e apresentação ampliada de perfil (Fase 3).
- Estado de disponibilidade dos módulos (Fase 4).
- Cadastro, edição e atribuição de papéis de usuários locais.
- SSO, OIDC, IGA, SCIM ou qualquer autenticação corporativa.
- Regras, dados ou permissões de negócio pertencentes aos módulos.

## Critérios de aceite

1. Dado que não existe perfil salvo, ao abrir o Hub a pessoa vê boas-vindas e disponibilidade do Hub e precisa selecionar um usuário local existente antes de entrar.
2. Dada uma seleção válida, o Hub salva apenas o identificador no navegador e abre a experiência inicial com perfil ativo e disponibilidade visíveis.
3. Dado um identificador salvo para um usuário local existente, ao reabrir o Hub a API valida o perfil antes de liberar a experiência.
4. Dado um identificador salvo para um usuário removido, o Hub o limpa, explica a situação e solicita nova seleção.
5. Dada uma falha ao carregar perfis ou validar a seleção, o Hub bloqueia a entrada na experiência, apresenta explicação e permite tentar novamente.
6. A pessoa consegue iniciar a troca de perfil por um controle visível; a experiência só continua após nova seleção validada.
7. A experiência não apresenta catálogo de módulos nem oferece operações de cadastro, edição ou atribuição de papéis nesta fase.

## Verificação e rastreabilidade

Derivar testes unitários, de integração/API e de navegador dos critérios de aceite ao decompor a entrega. Os testes foram executados e os resultados e commits locais estão registrados acima, com repositório, branch e SHA.
