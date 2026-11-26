# PMO Hub

Código do PMO Hub em monorepo npm. Aplicações de navegador ficam em `apps/`; APIs e serviços ficam em `services/`.

## Planejamento e tickets

Specs ficam em `docs/<feature>/`, junto ao código que descrevem. O acompanhamento de trabalho acontece como GitHub Issues. A Fase 1 do Hub está ligada às issues [#1](https://github.com/Zhong-star/pmo-hub/issues/1) e [#2](https://github.com/Zhong-star/pmo-hub/issues/2), com contexto adicional em [`docs/phase-1-entry/spec.md`](docs/phase-1-entry/spec.md).

## Hub local

O Hub, Lessons Learned e Tech Resource Allocation têm frontends React/Vite e APIs NestJS próprios. Na raiz do monorepo, execute `npm ci` e `npm run build`. Prepare o [PostgreSQL de Tech Resource Allocation](services/resource-allocation-api/README.md#local-postgresql), execute as migrações, [prepare o primeiro Admin](services/resource-allocation-api/README.md#prepare-the-first-admin) e [prepare os cadastros mínimos operacionais](services/resource-allocation-api/README.md#prepare-minimal-operational-records) (com [massa opcional de demonstração](services/resource-allocation-api/README.md#prepare-optional-demo-data), se desejar). O PostgreSQL de Lessons Learned é opcional. Quando usado, siga a [preparação do banco de Lessons Learned](services/lessons-learned-api/README.md).

Inicie cada componente em um terminal separado a partir da raiz. Defina a URL do banco do módulo nos terminais da respectiva API e do worker.

```sh
npm run start --workspace @pmo-hub/hub-api
npm run start --workspace @pmo-hub/lessons-learned-api
npm run start --workspace @pmo-hub/resource-allocation-api
npm run resource-allocation:worker
npm run dev --workspace @pmo-hub/lessons-learned
npm run dev --workspace @pmo-hub/resource-allocation
npm run dev --workspace @pmo-hub/hub
```

Abra [PMO Hub](http://127.0.0.1:5173) e selecione um perfil para abrir os módulos pelo catálogo. Os módulos e suas APIs passam pela mesma origem do Hub. Os caminhos de entrada são `/lessons-learned/` e `/resource-allocation/`. Cada módulo valida o perfil contra seu próprio cadastro.

`npm run contracts:generate` gera os contratos OpenAPI, os tipos do Hub e o cliente de Lessons Learned. Use `npm test`, `npm run typecheck` e `npm run lint` para verificar os workspaces.

As suítes PostgreSQL usam Testcontainers e requerem Docker. Execute `npm run test:integration --workspace @pmo-hub/lessons-learned-api` ou `npm run test:integration --workspace @pmo-hub/resource-allocation-api`.

Para executar as suítes de navegador, encerre os servidores de desenvolvimento. Se necessário, instale o Chromium do Playwright com `npx playwright install chromium`.

- `npm run test:e2e --workspace @pmo-hub/hub` para o Hub.
- `npm run test:e2e:lessons-learned --workspace @pmo-hub/hub` para Lessons Learned.
- `npm run test:e2e --workspace @pmo-hub/resource-allocation` para Tech Resource Allocation.

Consulte os READMEs da [Hub API](services/hub-api/README.md), da [Lessons Learned API](services/lessons-learned-api/README.md) e da [Tech Resource Allocation API](services/resource-allocation-api/README.md) para configurar perfis locais e papéis.

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

Para validar Lessons Learned com PostgreSQL, execute:

```powershell
node infrastructure/kubernetes/local/deploy.mjs backend --with-postgres
```

O comando provisiona o banco dedicado no cluster com volume persistente e gera o Secret local na primeira execução. Antes do rollout, executa as migrações TypeORM em um Job com a imagem da API. O Job e o Deployment usam a mesma URL do Secret. Repita o comando para verificar que não há migrações pendentes e confira as quatro rotas pela origem do Hub. Preserve o Secret junto com o volume para manter o acesso aos dados entre releases. Uma release com `backend` sem a opção `--with-postgres` desabilita a conexão da API. O rollback restaura as imagens e a configuração de conexão da release anterior. As migrações já aplicadas continuam no banco.

Para ativar os ETags por representação e os cursores compactos de Lessons Learned, valide primeiro uma release de backend com PostgreSQL e `LESSONS_LEARNED_TOKEN_FORMAT=legacy` (padrão). Essa versão recebe os dois formatos e emite o legado. Só então repita o deploy de backend com PostgreSQL e `LESSONS_LEARNED_TOKEN_FORMAT=representation`. O comando guarda o formato junto com a release e restaura ambos em caso de rollback. Para reverter a partir da fase de emissão nova, use uma release que já aceite os dois formatos.

Execute `node --test infrastructure/kubernetes/local/deploy.test.mjs` para verificar a proteção de rollback do comando de deploy com as chamadas de infraestrutura simuladas.

Para verificar a independência entre as camadas, compare as imagens antes e depois de cada deploy. Depois de uma release bem-sucedida, force a falha de um rollout e compare novamente. As quatro imagens devem voltar aos valores registrados imediatamente antes da falha:

```powershell
kubectl --context kind-pmo-hub -n pmo-hub get deployments -l layer -o custom-columns='NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image'
node infrastructure/kubernetes/local/deploy.mjs backend --fail=lessons-learned-api
kubectl --context kind-pmo-hub -n pmo-hub get deployments -l layer -o custom-columns='NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image'
```

Se o processo for interrompido à força e deixar a trava da camada, confirme que nenhum deploy dessa camada está em execução e remova o ConfigMap `pmo-frontend-deploy-lock` ou `pmo-backend-deploy-lock` do namespace `pmo-hub` antes de tentar de novo.

Antes de remover a trava do backend, confirme também que os Jobs `lessons-learned-migrate-*` terminaram com sucesso ou falha. Use `kubectl --context kind-pmo-hub -n pmo-hub get jobs` para consultar o estado e `kubectl logs job/<nome>` com o mesmo contexto e namespace para diagnosticar uma falha.

## Medição de desempenho de Tech Resource Allocation

O runner de medição cronometra no navegador as seis operações do release 1 e gera um relatório Markdown com o ambiente, os volumes reais, todas as amostras, mediana, máximo e aprovado/reprovado por meta. Ele usa uma configuração Playwright própria (`apps/resource-allocation/playwright.performance.config.ts`), fora do CI e das outras suítes. Não é teste de carga: mede um usuário por vez.

| Operação | Identidade | Meta |
| --- | --- | --- |
| Abrir o módulo (`/resource-allocation/`, lista de Requests) | `volume-user-0001` | 3 s |
| Fila de apresentação | `volume-admin` | 3 s |
| Minhas alocações | `volume-user-0001` | 3 s |
| Comparação semanal de capacidade | `volume-manager-01` | 3 s |
| Aprovar pedido sem alterações na fila de apresentação | `volume-admin` | 1 s |
| Criar alocação operacional própria | `volume-user-0001` | 1 s |

As aberturas vão da navegação até o conteúdo utilizável (sem indicadores de carregamento), cada uma em duas séries: fria (contexto de navegador novo, sem cache) e quente (nova navegação no mesmo contexto). As ações vão do clique de confirmação até o resultado lido de volta da API na interface. Cada repetição de aprovação consome um pedido diferente da fila (a massa padrão tem 90) e cada criação grava uma alocação de 1 h/semana numa semana futura. Uma operação é reprovada quando qualquer amostra passa da meta ou quando falta amostra; nenhuma amostra é omitida.

Antes de medir, prepare o banco com a [massa de volume](services/resource-allocation-api/README.md#prepare-volume-data-for-performance-measurement) no mesmo dia da medição e guarde a saída do comando, que contém a linha `VOLUME_DATASET_SUMMARY`.

Contra o kind, depois do deploy com `backend --with-postgres` e `frontend`, mantenha o port-forward do router em `:8080` e rode a massa pelo [PostgreSQL do kind](services/resource-allocation-api/README.md#run-against-the-kind-postgresql). Na raiz do monorepo:

```powershell
npm run prepare:volume --workspace @pmo-hub/resource-allocation-api | Tee-Object volume-summary.txt
$env:RESOURCE_ALLOCATION_PERF_ENVIRONMENT = 'kind'
$env:RESOURCE_ALLOCATION_PERF_VOLUME_SUMMARY = (Resolve-Path volume-summary.txt).Path
npm run perf:measure --workspace @pmo-hub/resource-allocation
```

Contra um ambiente local, prepare o PostgreSQL do módulo com migrações, primeiro Admin, cadastros mínimos e massa de volume, inicie a API e o worker e sirva o frontend com o proxy apontando para a API. Para medir o build de produção, use `vite preview`; o servidor de desenvolvimento também funciona, mas mede outro modo de build:

```powershell
npm run build --workspace @pmo-hub/resource-allocation
$env:RESOURCE_ALLOCATION_API_TARGET = 'http://127.0.0.1:3003'
npx --workspace @pmo-hub/resource-allocation vite preview --host 127.0.0.1 --port 5189 --strictPort
```

Em outro terminal:

```powershell
$env:RESOURCE_ALLOCATION_PERF_BASE_URL = 'http://127.0.0.1:5189'
$env:RESOURCE_ALLOCATION_PERF_ENVIRONMENT = 'local'
npm run perf:measure --workspace @pmo-hub/resource-allocation
```

O relatório fica em `apps/resource-allocation/performance-results/<data>/report.md`, junto com as amostras em JSON, e o caminho é impresso no fim da execução. O comando termina com código diferente de zero quando uma operação não consegue ser medida; uma operação medida acima da meta aparece como reprovada no relatório. Variáveis opcionais:

- `RESOURCE_ALLOCATION_PERF_BASE_URL` (padrão: `http://127.0.0.1:8080`, o router do kind): origem que serve `/resource-allocation/` e `/api/resource-allocation/v1`.
- `RESOURCE_ALLOCATION_PERF_REPETITIONS` (padrão: `10`): repetições por operação e por série. Use `1` para uma execução de fumaça.
- `RESOURCE_ALLOCATION_PERF_CHROMIUM_EXECUTABLE`: executável do Chromium a usar no lugar do navegador instalado pelo Playwright.
- `RESOURCE_ALLOCATION_PERF_ENVIRONMENT`: rótulo do ambiente no relatório.
- `RESOURCE_ALLOCATION_PERF_VOLUME_SUMMARY`: arquivo com a saída do `prepare:volume`; o relatório inclui as contagens por estado. Os volumes contados pela API entram sempre.
- `RESOURCE_ALLOCATION_PERF_BUILD_MODE`: substitui o modo de build detectado (o runner reconhece o servidor de desenvolvimento do Vite pela página).
- `RESOURCE_ALLOCATION_PERF_DEPLOYED_SHA`: SHA da versão implantada, quando difere do checkout que roda a medição.
- `RESOURCE_ALLOCATION_PERF_ADMIN_ID`, `RESOURCE_ALLOCATION_PERF_LEADERSHIP_ID`, `RESOURCE_ALLOCATION_PERF_USER_ID`: identidades locais (padrões `volume-admin`, `volume-manager-01`, `volume-user-0001`).
- `RESOURCE_ALLOCATION_PERF_OUTPUT_DIR` (padrão: `performance-results`, relativo a `apps/resource-allocation`) e `RESOURCE_ALLOCATION_PERF_SAMPLE_TIMEOUT_MS` (padrão: `60000`).
