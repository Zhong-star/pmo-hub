import type { MeasurementEnvironment } from './environment';
import { operations, type OperationDefinition, type OperationRecord, type Sample, type SampleSeries } from './results';
import { performanceSettings } from './settings';
import type { VolumeReport } from './volumes';

/**
 * Builds the Markdown report. An operation passes only when every expected sample was measured
 * and no sample is above its target; every sample is listed either way.
 */

export interface RunMetadata {
  startedAt: string;
  finishedAt: string;
  runDirectory: string;
}

interface SeriesVerdict {
  series: SampleSeries;
  samples: Sample[];
  median: number | null;
  max: number | null;
  passed: boolean;
  reason: string;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function seriesOf(definition: OperationDefinition): SampleSeries[] {
  return definition.kind === 'opening' ? ['cold', 'warm'] : ['action'];
}

const seriesLabels: Record<SampleSeries, string> = { cold: 'fria', warm: 'quente', action: 'ação' };

function verdictFor(definition: OperationDefinition, record: OperationRecord | null, series: SampleSeries, expected: number): SeriesVerdict {
  const samples = record?.samples.filter((sample) => sample.series === series) ?? [];
  const durations = samples.map((sample) => sample.durationMs);
  const max = durations.length > 0 ? Math.max(...durations) : null;
  const above = durations.filter((duration) => duration > definition.targetMs).length;
  let reason = '';
  if (above > 0) reason = `${above} de ${durations.length} amostras acima da meta`;
  else if (samples.length < expected) reason = `incompleta: ${samples.length} de ${expected} amostras`;
  else if ((record?.errors.length ?? 0) > 0) reason = 'erro durante a medição';
  return { series, samples, median: median(durations), max, passed: reason === '', reason };
}

function ms(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)} ms`;
}

function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function buildReport(
  metadata: RunMetadata,
  environment: MeasurementEnvironment | null,
  volumes: VolumeReport | null,
  records: Map<string, OperationRecord | null>,
): string {
  // Without environment.json the configured repetitions still apply, so missing samples always fail.
  const expected = environment?.repetitions ?? performanceSettings.repetitions;
  const lines: string[] = [];
  const verdicts = operations.map((definition) => {
    const record = records.get(definition.id) ?? null;
    return { definition, record, series: seriesOf(definition).map((series) => verdictFor(definition, record, series, expected)) };
  });
  const failed = verdicts.filter((entry) => entry.series.some((series) => !series.passed));
  const summary = volumes?.summary ?? null;
  const databaseCounts = summary && 'json' in summary ? summary.json : null;
  const missingDatabaseCounts = !volumes
    ? 'A etapa de preparação falhou antes de ler o resumo do `prepare:volume`'
    : summary === null
      ? 'O resumo do `prepare:volume` não foi informado (RESOURCE_ALLOCATION_PERF_VOLUME_SUMMARY)'
      : 'error' in summary ? `O resumo do \`prepare:volume\` em ${summary.source} não pôde ser lido: ${summary.error.replace(/\r?\n/g, ' ')}` : null;
  const databaseWarning = `> **Atenção: faltam as contagens no banco.** ${missingDatabaseCounts}. Este relatório não registra os volumes reais contados no banco; as contagens via API abaixo dependem do que cada identidade enxerga e não os substituem. Rode de novo com a saída do \`prepare:volume\` em RESOURCE_ALLOCATION_PERF_VOLUME_SUMMARY.`;

  lines.push('# Medição de desempenho — Tech Resource Allocation, release 1', '');
  lines.push(`Início: ${metadata.startedAt}. Fim: ${metadata.finishedAt}.`, '');
  lines.push(failed.length === 0
    ? '**Resultado geral: todas as operações cumprem a meta.**'
    : `**Resultado geral: ${failed.length} de ${operations.length} operações reprovadas** (${failed.map((entry) => entry.definition.title).join(', ')}).`, '');
  if (missingDatabaseCounts) lines.push(databaseWarning, '');

  lines.push('## Ambiente', '');
  if (environment) {
    lines.push('| Item | Valor |', '| --- | --- |');
    const rows: Array<[string, string]> = [
      ['Ambiente', environment.label],
      ['URL base', environment.baseURL],
      ['CPU', `${environment.cpu} (${environment.logicalCpus} CPUs lógicas)`],
      ['RAM', `${environment.ramGiB} GiB`],
      ['SO', environment.os],
      ['Node.js do runner', environment.node],
      ['Navegador', `${environment.browser}${environment.headless ? ', headless' : ''}`],
      ['Modo de build do frontend', environment.buildMode],
      ['SHA do runner', environment.runnerSha],
      ['SHA implantado', environment.deployedSha ?? 'não informado (RESOURCE_ALLOCATION_PERF_DEPLOYED_SHA)'],
      ['Repetições por operação', String(environment.repetitions)],
    ];
    for (const [item, value] of rows) lines.push(`| ${item} | ${cell(value)} |`);
  } else {
    lines.push('O ambiente não foi registrado: a etapa de preparação falhou antes das medições.');
  }
  lines.push('');

  lines.push('## Critério', '');
  lines.push('- Abertura (meta 3 s): da navegação (`performance.timeOrigin` da página) até o conteúdo utilizável, sem nenhum indicador "Loading…" ou "Checking…" visível. Fria: contexto de navegador novo, sem cache nem armazenamento. Quente: nova navegação completa no mesmo contexto, logo após a fria, com cache HTTP preenchido.');
  lines.push('- Ação comum (meta 1 s): do clique de confirmação até o resultado durável refletido na interface (lido de volta da API).');
  lines.push('- Uma série é aprovada somente quando todas as amostras esperadas foram medidas e nenhuma ficou acima da meta. A operação é aprovada quando todas as suas séries são aprovadas.', '');

  lines.push('## Resumo', '');
  lines.push('| Operação | Série | Meta | Amostras | Mediana | Máximo | Resultado |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const entry of verdicts) {
    for (const series of entry.series) {
      lines.push(`| ${entry.definition.title} | ${seriesLabels[series.series]} | ${entry.definition.targetMs} ms | ${series.samples.length}/${expected} | ${ms(series.median)} | ${ms(series.max)} | ${series.passed ? 'Aprovado' : `**Reprovado** (${series.reason})`} |`);
    }
  }
  lines.push('');

  lines.push('## Volumes reais', '');
  lines.push('### Contagens no banco (resumo do `prepare:volume`)', '');
  if (databaseCounts && summary) {
    lines.push(`Contadas no PostgreSQL pelo \`prepare:volume\` ao gerar a massa (${summary.source}).`, '');
    const counts = databaseCounts.counts;
    if (counts && typeof counts === 'object') {
      lines.push('| Registro | Total no banco |', '| --- | --- |');
      for (const [key, value] of Object.entries(counts as Record<string, unknown>)) lines.push(`| ${cell(key)} | ${cell(String(value))} |`);
      lines.push('');
    }
    for (const key of ['businessDate', 'options', 'requestsByState', 'allocationsByState', 'allocationsByOrigin', 'peopleByRole']) {
      if (databaseCounts[key] !== undefined) lines.push(`- ${key}: \`${JSON.stringify(databaseCounts[key])}\``);
    }
    lines.push('');
  } else {
    lines.push(databaseWarning, '');
  }

  lines.push('### Visíveis via API para cada identidade', '');
  if (volumes) {
    lines.push(`Contados pela API antes da primeira amostra, em ${volumes.countedAt}, com as identidades da medição. Mostram o que cada identidade enxerga, não o total do banco.`, '');
    lines.push('| Coleção | Identidade | Total |', '| --- | --- | --- |');
    for (const count of volumes.counts) {
      lines.push(`| ${count.label} | \`${count.identity}\` | ${count.count ?? `erro: ${cell(count.error ?? 'desconhecido')}`} |`);
    }
    lines.push('');
  } else {
    lines.push('Os volumes não foram contados: a etapa de preparação falhou.', '');
  }

  lines.push('## Amostras', '');
  for (const entry of verdicts) {
    lines.push(`### ${entry.definition.title}`, '');
    lines.push(`${entry.definition.measured} Identidade: \`${entry.record?.identity ?? '—'}\`. Meta: ${entry.definition.targetMs} ms.`, '');
    const samples = entry.record?.samples ?? [];
    if (samples.length === 0) {
      lines.push('Nenhuma amostra medida.', '');
    } else {
      lines.push('| Repetição | Série | Início (UTC) | Duração | Acima da meta | Observação |', '| --- | --- | --- | --- | --- | --- |');
      for (const sample of samples) {
        lines.push(`| ${sample.repetition} | ${seriesLabels[sample.series]} | ${sample.startedAt} | ${sample.durationMs} ms | ${sample.durationMs > entry.definition.targetMs ? '**sim**' : 'não'} | ${cell(sample.note ?? '')} |`);
      }
      lines.push('');
    }
    for (const error of entry.record?.errors ?? []) lines.push(`- Erro: ${cell(error)}`);
    if ((entry.record?.errors.length ?? 0) > 0) lines.push('');
  }

  lines.push(`Arquivos da execução: \`${metadata.runDirectory}\`.`, '');
  return `${lines.join('\n')}`;
}
