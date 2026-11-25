import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { businessDate, formatCalendarDate } from './timeAndHours';
import {
  CAPACITY_QUERY_ROOT,
  CapacityRequestError,
  getCapacityComparison,
  type CapacityComparisonFigures,
  type CapacityComparisonWeek,
  type CapacityFilters,
} from './capacityApi';

interface CapacityComparisonProps {
  localUserId: string;
  filters: CapacityFilters;
  onAccessDenied: () => void;
}

const oneDecimal = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Monday of the week that contains the date (weeks run Monday–Sunday). */
export function mondayOf(date: string): string {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return addDays(date, day === 0 ? -6 : 1 - day);
}

function hours(value: number): string {
  return `${oneDecimal.format(value)} h`;
}

function capacityText(figures: CapacityComparisonFigures): string {
  if (figures.capacityHours === null) return 'Capacity not configured';
  const known = `${hours(figures.capacityHours)} · ${oneDecimal.format(figures.capacityFte ?? 0)} FTE`;
  return figures.complete ? known : `${known} known`;
}

function utilizationText(figures: CapacityComparisonFigures): string {
  if (figures.utilizationPercent !== null) return `${oneDecimal.format(figures.utilizationPercent)}%`;
  if (figures.capacityHours === null) return 'No percentage';
  if (!figures.complete) return 'Incomplete';
  return 'No percentage (zero capacity)';
}

function classificationLabel(value: 'INTERNAL' | 'THIRD_PARTY' | null): string {
  if (value === 'INTERNAL') return 'Internal';
  if (value === 'THIRD_PARTY') return 'Third-party';
  return 'Unclassified';
}

function FigureCells({ figures }: { figures: CapacityComparisonFigures }) {
  return (
    <>
      <td>{hours(figures.plannedHours)}</td>
      <td>{figures.suspendedHours > 0 ? hours(figures.suspendedHours) : '—'}</td>
      <td className={figures.capacityHours === null ? 'capacity-compare-missing' : undefined}>{capacityText(figures)}</td>
      <td className={figures.utilizationPercent === null ? 'capacity-compare-missing' : figures.utilizationPercent > 100 ? 'capacity-compare-over' : undefined}>
        {utilizationText(figures)}
      </td>
    </>
  );
}

function WeekTable({ week }: { week: CapacityComparisonWeek }) {
  const caption = `Week of ${formatCalendarDate(week.weekStart)} – ${formatCalendarDate(week.weekEnd)}`;
  return (
    <section className="capacity-compare-week" aria-label={caption}>
      <h4>{caption}</h4>
      {week.groups.length === 0 ? (
        <p className="capacity-empty-state">No capacity or allocations in your scope for this week.</p>
      ) : (
        <div className="capacity-compare-table-wrap">
          <table className="capacity-compare-table">
            <caption className="sr-only">{caption}: planned work, suspended hours, capacity and utilization</caption>
            <thead>
              <tr>
                <th scope="col">Group / profile / classification</th>
                <th scope="col">Planned work</th>
                <th scope="col">Suspended</th>
                <th scope="col">Capacity</th>
                <th scope="col">Utilization</th>
              </tr>
            </thead>
            {week.groups.map((group) => (
              <tbody key={group.group.id}>
                <tr className="capacity-compare-group">
                  <th scope="row">{group.group.name}</th>
                  <FigureCells figures={group.total} />
                </tr>
                {group.profiles.map((profile) => (
                  <ProfileRows key={profile.resourceProfile.id} profile={profile} />
                ))}
                <tr className="capacity-compare-note">
                  <th scope="row">Vacation · {group.group.name}</th>
                  <td colSpan={4}>{group.vacationHours > 0 ? `${hours(group.vacationHours)} (not deducted from capacity)` : 'None'}</td>
                </tr>
              </tbody>
            ))}
            <tfoot>
              <tr className="capacity-compare-total">
                <th scope="row">All groups shown</th>
                <FigureCells figures={week.total} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

function ProfileRows({ profile }: { profile: CapacityComparisonWeek['groups'][number]['profiles'][number] }) {
  const name = `${profile.resourceProfile.name}${profile.resourceProfile.active ? '' : ' (inactive profile)'}`;
  return (
    <>
      <tr className="capacity-compare-profile">
        <th scope="row">{name}</th>
        <FigureCells figures={profile.total} />
      </tr>
      {profile.classifications.map((row) => (
        <tr key={row.classification ?? 'unclassified'} className="capacity-compare-classification">
          <th scope="row">{name} · {classificationLabel(row.classification)}</th>
          <FigureCells figures={row} />
        </tr>
      ))}
    </>
  );
}

export function CapacityComparison({ localUserId, filters, onAccessDenied }: CapacityComparisonProps) {
  const currentWeek = mondayOf(businessDate());
  const [weekStart, setWeekStart] = useState(currentWeek);
  const [weekCount, setWeekCount] = useState(1);
  const weekEnd = addDays(weekStart, (weekCount - 1) * 7);
  const query = useQuery({
    queryKey: [...CAPACITY_QUERY_ROOT, localUserId, 'comparison', weekStart, weekEnd, filters.groupId ?? '', filters.resourceProfileId ?? '', filters.classification ?? ''],
    queryFn: () => getCapacityComparison(localUserId, { weekStart, weekEnd, ...filters }),
    retry: false,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (query.error instanceof CapacityRequestError && (query.error.status === 401 || query.error.status === 403)) onAccessDenied();
  }, [onAccessDenied, query.error]);

  return (
    <section className="capacity-compare" aria-labelledby="capacity-compare-title">
      <div className="capacity-list-heading">
        <div>
          <h3 id="capacity-compare-title">Weekly comparison</h3>
          <p>
            Planned work against FTE capacity (1 FTE = 40 h). Weeks run Monday–Sunday and only weekdays count, in São Paulo dates.
            Values reflect current records and are not a closed accounting period.
          </p>
        </div>
      </div>
      <div className="capacity-compare-controls">
        <label>
          <span>First week (Monday)</span>
          <input type="date" value={weekStart} step={7} onChange={(event) => event.target.value && setWeekStart(mondayOf(event.target.value))} />
        </label>
        <label>
          <span>Weeks</span>
          <select value={weekCount} onChange={(event) => setWeekCount(Number(event.target.value))}>
            {[1, 2, 4, 8, 13, 26].map((count) => <option key={count} value={count}>{count === 1 ? '1 week' : `${count} weeks`}</option>)}
          </select>
        </label>
        <div className="capacity-compare-nav">
          <button type="button" className="secondary-button" onClick={() => setWeekStart(addDays(weekStart, -7))}>Previous week</button>
          <button type="button" className="secondary-button" onClick={() => setWeekStart(currentWeek)} disabled={weekStart === currentWeek}>Current week</button>
          <button type="button" className="secondary-button" onClick={() => setWeekStart(addDays(weekStart, 7))}>Next week</button>
        </div>
      </div>
      {query.isPending && <p className="capacity-empty-state" role="status">Loading the weekly comparison…</p>}
      {query.isError && !(query.error instanceof CapacityRequestError && (query.error.status === 401 || query.error.status === 403)) && (
        <div className="form-error" role="alert">
          <p>{query.error instanceof CapacityRequestError ? query.error.message : 'The weekly comparison could not be loaded.'}</p>
          <button type="button" className="secondary-button" onClick={() => void query.refetch()} disabled={query.isFetching}>Try again</button>
        </div>
      )}
      {query.isSuccess && query.data.weeks.map((week) => <WeekTable key={week.weekStart} week={week} />)}
      <p className="capacity-compare-legend">
        “Incomplete” means some weekdays, a classification, or Unclassified load lack capacity, so no percentage is shown; known values stay visible.
        Utilization above 100% is shown without blocking or alerts.
      </p>
    </section>
  );
}
