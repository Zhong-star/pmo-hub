# PMO Hub

Código do PMO Hub em monorepo npm. Aplicações de navegador ficam em `apps/`; APIs e serviços ficam em `services/`.

## Planejamento e tickets

Specs ficam em `docs/<feature>/`, junto ao código que descrevem. O acompanhamento de trabalho acontece como GitHub Issues. A Fase 1 do Hub está ligada às issues [#1](https://github.com/Zhong-star/pmo-hub/issues/1) e [#2](https://github.com/Zhong-star/pmo-hub/issues/2), com contexto adicional em [`docs/phase-1-entry/spec.md`](docs/phase-1-entry/spec.md).

## Hub local

O Hub e Lessons Learned têm frontends React/Vite e APIs NestJS próprios. Na raiz do monorepo, execute `npm ci` e `npm run build`. Inicie cada componente em um terminal separado, a partir da raiz:

```sh
npm run start --workspace @pmo-hub/hub-api
npm run start --workspace @pmo-hub/lessons-learned-api
npm run dev --workspace @pmo-hub/lessons-learned
npm run dev --workspace @pmo-hub/hub
```

Abra [PMO Hub](http://127.0.0.1:5173) e selecione um perfil para abrir Lessons Learned pelo catálogo. Para acessar a tela técnica diretamente, use [Lessons Learned](http://127.0.0.1:5173/lessons-learned). O servidor local do Hub é o ponto de entrada para os dois frontends e suas APIs. Lessons Learned mostra o estado da própria API e oferece o link **PMO Hub** de retorno.

`npm run contracts:generate` gera os contratos OpenAPI, os tipos do Hub e o cliente de Lessons Learned. Use `npm test`, `npm run typecheck` e `npm run lint` para verificar os workspaces.

O PostgreSQL local de Lessons Learned é opcional e pertence ao serviço `services/lessons-learned-api`. Consulte o README do serviço para iniciar o Compose e executar `npm run migration:run`. O teste PostgreSQL isolado usa Testcontainers e é executado separadamente com `npm run test:integration --workspace @pmo-hub/lessons-learned-api` (requer Docker).

Para verificar a navegação no navegador, encerre os servidores de desenvolvimento e execute `npm run test:e2e --workspace @pmo-hub/hub` para o Hub e `npm run test:e2e:lessons-learned --workspace @pmo-hub/hub` para Lessons Learned. Se o Chromium do Playwright ainda não estiver instalado, execute `npx playwright install chromium` primeiro.

Perfis locais de desenvolvimento são configurados pela API; consulte o README do serviço Hub API.

## Kubernetes local

Use Node.js, Docker em modo Linux, [kind](https://kind.sigs.k8s.io/docs/user/quick-start/) e [kubectl](https://kubernetes.io/docs/tasks/tools/) no PATH. Execute na raiz do monorepo:

```powershell
node infrastructure/kubernetes/local/deploy.mjs setup
node infrastructure/kubernetes/local/deploy.mjs backend
node infrastructure/kubernetes/local/deploy.mjs frontend
kubectl --context kind-pmo-hub -n pmo-hub port-forward service/pmo-router 8080:8080
```

Abra [o Hub](http://127.0.0.1:8080/) ou [Lessons Learned](http://127.0.0.1:8080/lessons-learned/). As APIs respondem em `/api/hub/v1/status` e `/api/lessons-learned/v1/health`. O PostgreSQL está desabilitado nesta configuração.

Execute `frontend` para atualizar Hub e Lessons Learned, ou `backend` para atualizar as duas APIs. O comando cria versões novas das duas imagens da camada, carrega as imagens no kind e aguarda ambos os rollouts. Em caso de falha, ele tenta restaurar as duas imagens da última release pronta e retorna um código de erro mesmo quando a restauração funciona.

Para verificar a independência entre as camadas, compare as imagens antes e depois de cada deploy. Depois de uma release bem-sucedida, force a falha de um rollout e compare novamente. As quatro imagens devem voltar aos valores registrados imediatamente antes da falha:

```powershell
kubectl --context kind-pmo-hub -n pmo-hub get deployments -l layer -o custom-columns='NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image'
node infrastructure/kubernetes/local/deploy.mjs backend --fail=lessons-learned-api
kubectl --context kind-pmo-hub -n pmo-hub get deployments -l layer -o custom-columns='NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image'
```

Se o processo for interrompido à força e deixar a trava da camada, confirme que nenhum deploy dessa camada está em execução e remova o ConfigMap `pmo-frontend-deploy-lock` ou `pmo-backend-deploy-lock` do namespace `pmo-hub` antes de tentar de novo.
