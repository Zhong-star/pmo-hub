import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import {
  AdministrationRequestError,
  createAdminResource,
  getAdminCollection,
  getAdminResource,
  updateAdminResource,
  type AdminCollection,
  type AdminGroup,
  type AdminInitiative,
  type AdminPerson,
  type AdminResourceProfile,
  type ResourceAllocationRole,
} from './administrationApi';

interface AdministrationProps {
  localUserId: string;
  onAccessDenied: () => void;
}

type AdminRecord = AdminPerson | AdminGroup | AdminResourceProfile | AdminInitiative;
type EditorMode = 'create' | 'edit';
type EditorState = { collection: AdminCollection; mode: EditorMode; id?: string };

interface FormValues {
  localUserId: string;
  displayName: string;
  email: string;
  role: ResourceAllocationRole | '';
  groupId: string;
  name: string;
  code: string;
  active: boolean;
  supervisorId: string;
  managerId: string;
}

const defaultValues: FormValues = {
  localUserId: '',
  displayName: '',
  email: '',
  role: '',
  groupId: '',
  name: '',
  code: '',
  active: true,
  supervisorId: '',
  managerId: '',
};

const collectionLabels: Record<AdminCollection, string> = {
  people: 'People',
  groups: 'Groups',
  'resource-profiles': 'Resource profiles',
  initiatives: 'Initiatives',
};

const collectionSingularLabels: Record<AdminCollection, string> = {
  people: 'person',
  groups: 'group',
  'resource-profiles': 'resource profile',
  initiatives: 'initiative',
};

const collectionDescriptions: Record<AdminCollection, string> = {
  people: 'Manage local identities, contact details, and module roles.',
  groups: 'Manage groups and assign their active supervisors and managers.',
  'resource-profiles': 'Manage resource profiles and the groups they belong to.',
  initiatives: 'Manage ITDM codes and initiative names.',
};

const collectionOrder: AdminCollection[] = ['people', 'groups', 'resource-profiles', 'initiatives'];

function getRows<T>(data: { pages: Array<{ items: T[] }> } | undefined): T[] {
  return data?.pages.flatMap((page) => page.items) ?? [];
}

function queryKey(localUserId: string, collection: AdminCollection) {
  return ['resource-allocation-admin', localUserId, collection] as const;
}

function isAccessDenied(error: unknown): boolean {
  return error instanceof AdministrationRequestError && (error.status === 401 || error.status === 403);
}

function recordLabel(collection: AdminCollection, record: AdminRecord): string {
  switch (collection) {
    case 'people': return (record as AdminPerson).displayName;
    case 'groups': return (record as AdminGroup).name;
    case 'resource-profiles': return (record as AdminResourceProfile).name;
    case 'initiatives': return (record as AdminInitiative).code;
  }
}

function activeBadge(active: boolean) {
  return <span className={active ? 'status-badge status-badge-active' : 'status-badge'}>{active ? 'Active' : 'Inactive'}</span>;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof AdministrationRequestError) {
    if (error.status === 412) {
      return 'This record changed after you opened it. Your edits are still here. Close this form and edit the record again to review the latest version.';
    }
    if (error.problem?.code === 'RESOURCE_CONFLICT') {
      return error.message || 'This value conflicts with an existing record.';
    }
    return error.message;
  }
  return 'The administration service is temporarily unavailable. Try again.';
}

function applyServerFieldErrors(
  error: unknown,
  setError: (name: keyof FormValues, error: { type: string; message: string }) => void,
) {
  if (!(error instanceof AdministrationRequestError)) return;
  for (const fieldError of error.problem?.errors ?? []) {
    const field = fieldError.path?.split('.').at(-1) as keyof FormValues | undefined;
    if (field && field in defaultValues && fieldError.message) {
      setError(field, { type: 'server', message: fieldError.message });
    }
  }
}

function valuesFromRecord(collection: AdminCollection, record: AdminRecord): FormValues {
  switch (collection) {
    case 'people': {
      const person = record as AdminPerson;
      return {
        ...defaultValues,
        localUserId: person.localUserId,
        displayName: person.displayName,
        email: person.email,
        role: person.role,
        groupId: person.groupId ?? '',
        active: person.active,
      };
    }
    case 'groups': {
      const group = record as AdminGroup;
      return {
        ...defaultValues,
        name: group.name,
        active: group.active,
        supervisorId: group.supervisorId ?? '',
        managerId: group.managerId ?? '',
      };
    }
    case 'resource-profiles': {
      const profile = record as AdminResourceProfile;
      return { ...defaultValues, name: profile.name, groupId: profile.groupId, active: profile.active };
    }
    case 'initiatives': {
      const initiative = record as AdminInitiative;
      return { ...defaultValues, code: initiative.code, name: initiative.name, active: initiative.active };
    }
  }
}

function payloadFromValues(collection: AdminCollection, values: FormValues) {
  switch (collection) {
    case 'people': {
      const payload: Record<string, unknown> = {
        localUserId: values.localUserId.trim(),
        displayName: values.displayName.trim(),
        email: values.email.trim(),
        role: values.role,
        groupId: values.groupId || null,
        active: values.active,
      };
      return payload;
    }
    case 'groups':
      return {
        name: values.name.trim(),
        active: values.active,
        supervisorId: values.supervisorId || null,
        managerId: values.managerId || null,
      };
    case 'resource-profiles':
      return { name: values.name.trim(), groupId: values.groupId, active: values.active };
    case 'initiatives':
      return { code: values.code.trim(), name: values.name.trim(), active: values.active };
  }
}

function createPageQuery<C extends AdminCollection>(collection: C, localUserId: string) {
  return {
    queryKey: queryKey(localUserId, collection),
    queryFn: ({ pageParam }: { pageParam: string | null }) => getAdminCollection(collection, localUserId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage: { page: { nextCursor: string | null } }) => lastPage.page.nextCursor ?? undefined,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    retry: false,
  };
}

function Administration({ localUserId, onAccessDenied }: AdministrationProps) {
  const peopleQuery = useInfiniteQuery(createPageQuery('people', localUserId));
  const groupsQuery = useInfiniteQuery(createPageQuery('groups', localUserId));
  const profilesQuery = useInfiniteQuery(createPageQuery('resource-profiles', localUserId));
  const initiativesQuery = useInfiniteQuery(createPageQuery('initiatives', localUserId));
  const queryClient = useQueryClient();
  const [selectedCollection, setSelectedCollection] = useState<AdminCollection>('people');
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [notice, setNotice] = useState('');

  const people = useMemo(() => getRows<AdminPerson>(peopleQuery.data), [peopleQuery.data]);
  const groups = useMemo(() => getRows<AdminGroup>(groupsQuery.data), [groupsQuery.data]);
  const profiles = useMemo(() => getRows<AdminResourceProfile>(profilesQuery.data), [profilesQuery.data]);
  const initiatives = useMemo(() => getRows<AdminInitiative>(initiativesQuery.data), [initiativesQuery.data]);
  const queryByCollection = {
    people: peopleQuery,
    groups: groupsQuery,
    'resource-profiles': profilesQuery,
    initiatives: initiativesQuery,
  };
  const peopleById = useMemo(() => new Map(people.map((person) => [person.id, person])), [people]);
  const groupsById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);

  const hasAccessError = (peopleQuery.isError && isAccessDenied(peopleQuery.error))
    || (groupsQuery.isError && isAccessDenied(groupsQuery.error))
    || (profilesQuery.isError && isAccessDenied(profilesQuery.error))
    || (initiativesQuery.isError && isAccessDenied(initiativesQuery.error));

  useEffect(() => {
    if (hasAccessError) onAccessDenied();
  }, [hasAccessError, onAccessDenied]);

  const recordsByCollection: Record<AdminCollection, AdminRecord[]> = {
    people,
    groups,
    'resource-profiles': profiles,
    initiatives,
  };
  const currentQuery = queryByCollection[selectedCollection];
  const currentRecords = recordsByCollection[selectedCollection];
  const hasInitialError = [peopleQuery, groupsQuery, profilesQuery, initiativesQuery].some((query) =>
    query.isError && !query.isFetchNextPageError);

  function openEditor(nextEditor: EditorState) {
    setNotice('');
    setEditor(nextEditor);
  }

  function closeEditor() {
    setEditor(null);
  }

  function openCollection(collection: AdminCollection) {
    setSelectedCollection(collection);
    setEditor(null);
    setNotice('');
  }

  return (
    <section className="administration-card" aria-labelledby="administration-title">
      <div className="administration-heading">
        <div>
          <p className="eyebrow">Admin workspace</p>
          <h2 id="administration-title">Administration</h2>
          <p className="supporting-copy">Manage people, groups, resource profiles, and initiatives.</p>
        </div>
      </div>

      <div className="admin-tabs" role="tablist" aria-label="Administrative records">
        {collectionOrder.map((collection) => (
          <button
            key={collection}
            id={`tab-${collection}`}
            role="tab"
            type="button"
            aria-selected={selectedCollection === collection}
            aria-controls="admin-record-panel"
            tabIndex={selectedCollection === collection ? 0 : -1}
            onClick={() => openCollection(collection)}
          >
            {collectionLabels[collection]}
          </button>
        ))}
      </div>

      <section id="admin-record-panel" className="admin-record-panel" role="tabpanel"
        aria-labelledby={`tab-${selectedCollection}`}>
        <div className="admin-panel-heading">
          <div>
            <h3>{collectionLabels[selectedCollection]}</h3>
            <p>{collectionDescriptions[selectedCollection]}</p>
          </div>
          <button
            className="primary-button"
            type="button"
            onClick={() => openEditor({ collection: selectedCollection, mode: 'create' })}
          >
            Add {collectionSingularLabels[selectedCollection]}
          </button>
        </div>

        {notice && <p className="inline-success" role="status">{notice}</p>}

        {hasInitialError && (
          <div className="form-error" role="alert">
            <p>Could not load administrative records. Your saved work is unchanged.</p>
            <button type="button" className="text-button" onClick={() => void currentQuery.refetch()}>
              Try again
            </button>
          </div>
        )}

        {currentQuery.isPending && <p className="supporting-copy" role="status">Loading {collectionLabels[selectedCollection].toLowerCase()}…</p>}

        {!currentQuery.isPending && currentRecords.length === 0 && !currentQuery.isError && (
          <p className="empty-state">No {collectionLabels[selectedCollection].toLowerCase()} have been added yet.</p>
        )}

        {currentRecords.length > 0 && (
          <RecordTable
            collection={selectedCollection}
            records={currentRecords}
            peopleById={peopleById}
            groupsById={groupsById}
            onEdit={(record) => openEditor({ collection: selectedCollection, mode: 'edit', id: record.id })}
          />
        )}

        {(currentQuery.hasNextPage || currentQuery.isFetchNextPageError) && (
          <div className="load-more-row">
            {currentQuery.isFetchNextPageError && (
              <p className="form-error" role="alert">More records could not be loaded. The records already shown are still available.</p>
            )}
            <button
              className="secondary-button"
              type="button"
              disabled={currentQuery.isFetching || (currentQuery.isError && !currentQuery.isFetchNextPageError)}
              onClick={() => void currentQuery.fetchNextPage()}
            >
              {currentQuery.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}

        {editor && (
          <RecordEditor
            key={`${editor.collection}:${editor.mode}:${editor.id ?? 'new'}`}
            editor={editor}
            localUserId={localUserId}
            people={people}
            groups={groups}
            onClose={closeEditor}
            onAccessDenied={onAccessDenied}
            onSaved={async (message) => {
              await queryClient.resetQueries({
                queryKey: ['resource-allocation-admin', localUserId],
                predicate: (query) => query.queryKey[3] !== 'detail',
              });
              if (editor.collection === 'people') {
                await queryClient.invalidateQueries({ queryKey: ['resource-allocation-access', localUserId] });
              }
              setEditor(null);
              setNotice(message);
            }}
            onLoadMorePeople={() => void peopleQuery.fetchNextPage()}
            onLoadMoreGroups={() => void groupsQuery.fetchNextPage()}
            canLoadMorePeople={Boolean(peopleQuery.hasNextPage)}
            canLoadMoreGroups={Boolean(groupsQuery.hasNextPage)}
          />
        )}
      </section>
    </section>
  );
}

function RecordTable({
  collection,
  records,
  peopleById,
  groupsById,
  onEdit,
}: {
  collection: AdminCollection;
  records: AdminRecord[];
  peopleById: Map<string, AdminPerson>;
  groupsById: Map<string, AdminGroup>;
  onEdit: (record: AdminRecord & { id: string }) => void;
}) {
  const headings: Record<AdminCollection, string[]> = {
    people: ['Person', 'Role', 'Primary group and coverage', 'Status', 'Actions'],
    groups: ['Group', 'Supervisor', 'Manager', 'Status', 'Actions'],
    'resource-profiles': ['Resource profile', 'Group', 'Status', 'Actions'],
    initiatives: ['Code', 'Name', 'Status', 'Actions'],
  };

  function editButton(record: AdminRecord & { id: string }) {
    return (
      <button className="text-button" type="button" aria-label={`Edit ${collectionSingularLabels[collection]} ${recordLabel(collection, record)}`} onClick={() => onEdit(record)}>
        Edit
      </button>
    );
  }

  return (
    <div className="table-scroll">
      <table className="admin-table">
        <caption className="sr-only">{collectionLabels[collection]}</caption>
        <thead><tr>{headings[collection].map((heading) => <th key={heading} scope="col">{heading}</th>)}</tr></thead>
        <tbody>
          {records.map((record) => {
            switch (collection) {
              case 'people': {
                const person = record as AdminPerson;
                const groupNames = person.coveredGroupIds.map((id) => groupsById.get(id)?.name ?? 'Group unavailable');
                const assignedGroup = person.groupId ? groupsById.get(person.groupId)?.name ?? 'Group unavailable' : null;
                const hasGroupCoverage = person.role === 'ALLOCATION_SUPERVISOR' || person.role === 'ALLOCATION_MANAGER';
                const groupDetails = [
                  assignedGroup ? `Primary: ${assignedGroup}` : null,
                  hasGroupCoverage ? `Coverage: ${groupNames.length ? groupNames.join(', ') : 'None'}` : null,
                ].filter((value): value is string => Boolean(value));
                return (
                  <tr key={person.id}>
                    <td><strong>{person.displayName}</strong><span>{person.email}</span></td>
                    <td>{person.role.replace('ALLOCATION_', '').replaceAll('_', ' ')}</td>
                    <td>{groupDetails.length ? groupDetails.join(' · ') : 'None'}</td>
                    <td>{activeBadge(person.active)}</td>
                    <td>{editButton(person)}</td>
                  </tr>
                );
              }
              case 'groups': {
                const group = record as AdminGroup;
                return (
                  <tr key={group.id}>
                    <td><strong>{group.name}</strong></td>
                    <td>{group.supervisorId ? peopleById.get(group.supervisorId)?.displayName ?? 'Person unavailable' : 'Unassigned'}</td>
                    <td>{group.managerId ? peopleById.get(group.managerId)?.displayName ?? 'Person unavailable' : 'Unassigned'}</td>
                    <td>{activeBadge(group.active)}</td>
                    <td>{editButton(group)}</td>
                  </tr>
                );
              }
              case 'resource-profiles': {
                const profile = record as AdminResourceProfile;
                return (
                  <tr key={profile.id}>
                    <td><strong>{profile.name}</strong></td>
                    <td>{groupsById.get(profile.groupId)?.name ?? 'Group unavailable'}</td>
                    <td>{activeBadge(profile.active)}</td>
                    <td>{editButton(profile)}</td>
                  </tr>
                );
              }
              case 'initiatives': {
                const initiative = record as AdminInitiative;
                return (
                  <tr key={initiative.id}>
                    <td><strong>{initiative.code}</strong></td>
                    <td>{initiative.name}</td>
                    <td>{activeBadge(initiative.active)}</td>
                    <td>{editButton(initiative)}</td>
                  </tr>
                );
              }
            }
          })}
        </tbody>
      </table>
    </div>
  );
}

function RecordEditor({
  editor,
  localUserId,
  people,
  groups,
  onClose,
  onAccessDenied,
  onSaved,
  onLoadMorePeople,
  onLoadMoreGroups,
  canLoadMorePeople,
  canLoadMoreGroups,
}: {
  editor: EditorState;
  localUserId: string;
  people: AdminPerson[];
  groups: AdminGroup[];
  onClose: () => void;
  onAccessDenied: () => void;
  onSaved: (message: string) => Promise<void>;
  onLoadMorePeople: () => void;
  onLoadMoreGroups: () => void;
  canLoadMorePeople: boolean;
  canLoadMoreGroups: boolean;
}) {
  const detailQuery = useQuery({
    queryKey: ['resource-allocation-admin', localUserId, editor.collection, 'detail', editor.id],
    queryFn: () => getAdminResource(editor.collection, editor.id!, localUserId),
    enabled: editor.mode === 'edit' && Boolean(editor.id),
    staleTime: 0,
    retry: false,
  });
  const { register, handleSubmit, reset, control, setError, formState } = useForm<FormValues>({ defaultValues });
  const role = useWatch({ control, name: 'role' });
  const active = useWatch({ control, name: 'active' });
  const [submissionError, setSubmissionError] = useState('');
  const idempotencyKeys = useRef(new Map<string, string>());
  const detail = detailQuery.data;

  useEffect(() => {
    if (detail?.record) reset(valuesFromRecord(editor.collection, detail.record));
  }, [detail, editor.collection, reset]);

  useEffect(() => {
    if (detailQuery.isError && isAccessDenied(detailQuery.error)) onAccessDenied();
  }, [detailQuery.error, detailQuery.isError, onAccessDenied]);

  const mutation = useMutation({
    mutationFn: (values: FormValues) => {
      const payload = payloadFromValues(editor.collection, values);
      if (editor.mode === 'create') {
        const fingerprint = JSON.stringify(payload);
        let idempotencyKey = idempotencyKeys.current.get(fingerprint);
        if (!idempotencyKey) {
          idempotencyKey = crypto.randomUUID();
          idempotencyKeys.current.set(fingerprint, idempotencyKey);
        }
        return createAdminResource(editor.collection, localUserId, payload, idempotencyKey);
      }
      return updateAdminResource(editor.collection, editor.id!, localUserId, detail?.etag ?? '', payload);
    },
    onSuccess: async () => {
      const verb = editor.mode === 'create' ? 'created' : 'updated';
      await onSaved(`${collectionLabels[editor.collection]} record ${verb}.`);
    },
    onError: (error) => {
      setSubmissionError(getErrorMessage(error));
      applyServerFieldErrors(error, setError);
      if (isAccessDenied(error)) onAccessDenied();
    },
  });

  const onSubmit = handleSubmit((values) => {
    setSubmissionError('');
    mutation.mutate(values);
  });

  const groupOptions = groups.filter((group) => group.active);
  const supervisors = people.filter((person) => person.active && person.role === 'ALLOCATION_SUPERVISOR');
  const managers = people.filter((person) => person.active && person.role === 'ALLOCATION_MANAGER');
  const heading = `${editor.mode === 'create' ? 'Add' : 'Edit'} ${collectionSingularLabels[editor.collection]}`;

  if (editor.mode === 'edit' && detailQuery.isPending) {
    return <div className="editor-panel" role="status">Loading record details…</div>;
  }
  if (editor.mode === 'edit' && detailQuery.isError) {
    return (
      <div className="editor-panel" role="alert">
        <p>{getErrorMessage(detailQuery.error)}</p>
        <button type="button" className="secondary-button" onClick={onClose}>Close</button>
      </div>
    );
  }

  const registerField = (field: keyof FormValues, label: string, type = 'text', required = false) => (
    <label className="form-field" htmlFor={`admin-${field}`}>
      <span>{label}{required && <span aria-hidden="true"> *</span>}</span>
      <input
        id={`admin-${field}`}
        type={type}
        aria-invalid={Boolean(formState.errors[field])}
        aria-describedby={formState.errors[field] ? `admin-${field}-error` : undefined}
        {...register(field, required ? { required: `Enter ${label.toLowerCase()}.` } : {})}
      />
      {formState.errors[field]?.message && <span id={`admin-${field}-error`} className="field-error">{formState.errors[field]?.message}</span>}
    </label>
  );

  const renderSelect = (
    field: keyof FormValues,
    label: string,
    options: Array<{ id: string; label: string }>,
    required: boolean,
    requiredWhenActive = false,
  ) => (
    <label className="form-field" htmlFor={`admin-${field}`}>
      <span>{label}{(required || (requiredWhenActive && active)) && <span aria-hidden="true"> *</span>}</span>
      <select
        id={`admin-${field}`}
        aria-invalid={Boolean(formState.errors[field])}
        aria-describedby={formState.errors[field] ? `admin-${field}-error` : undefined}
        {...register(field, {
          validate: (value) => {
            if (required && !String(value)) return `Select ${label.toLowerCase()}.`;
            if (requiredWhenActive && active && !String(value)) return `Select an active ${label.toLowerCase()} for an active group.`;
            return true;
          },
        })}
      >
        <option value="">{required || (requiredWhenActive && active) ? `Choose ${label.toLowerCase()}` : `No ${label.toLowerCase()} selected`}</option>
        {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
      {formState.errors[field]?.message && <span id={`admin-${field}-error`} className="field-error">{formState.errors[field]?.message}</span>}
    </label>
  );

  function selectMore(collection: 'people' | 'groups', hasMore: boolean, onLoadMore: () => void) {
    if (!hasMore) return null;
    return <button type="button" className="text-button load-options" onClick={onLoadMore}>Load more {collection}</button>;
  }

  return (
    <section className="editor-panel" aria-labelledby="editor-title">
      <div className="editor-heading">
        <div>
          <h4 id="editor-title">{heading}</h4>
          <p>Fields marked with an asterisk are required.</p>
        </div>
        <button className="icon-button" type="button" aria-label="Close form" onClick={onClose}>Close</button>
      </div>

      {submissionError && <p className="form-error" role="alert">{submissionError}</p>}

      <form className="admin-form" onSubmit={(event) => void onSubmit(event)} noValidate>
        {editor.collection === 'people' && (
          <>
            {registerField('localUserId', 'Local user ID', 'text', true)}
            {registerField('displayName', 'Display name', 'text', true)}
            <label className="form-field" htmlFor="admin-email">
              <span>Email <span aria-hidden="true">*</span></span>
              <input
                id="admin-email"
                type="email"
                aria-invalid={Boolean(formState.errors.email)}
                aria-describedby={formState.errors.email ? 'admin-email-error' : undefined}
                {...register('email', {
                  required: 'Enter an email address.',
                  pattern: { value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: 'Enter a valid email address.' },
                })}
              />
              {formState.errors.email?.message && <span id="admin-email-error" className="field-error">{formState.errors.email.message}</span>}
            </label>
            <label className="form-field" htmlFor="admin-role">
              <span>Role <span aria-hidden="true">*</span></span>
              <select id="admin-role" aria-invalid={Boolean(formState.errors.role)} {...register('role', { required: 'Choose a role.' })}>
                <option value="">Choose role</option>
                <option value="ALLOCATION_USER">User</option>
                <option value="ALLOCATION_MODERATOR">Moderator</option>
                <option value="ALLOCATION_SUPERVISOR">Supervisor</option>
                <option value="ALLOCATION_MANAGER">Manager</option>
                <option value="ALLOCATION_ADMIN">Admin</option>
              </select>
              {formState.errors.role?.message && <span className="field-error">{formState.errors.role.message}</span>}
            </label>
            <div className="field-with-help">
              {renderSelect('groupId', 'Group', groupOptions.map((group) => ({ id: group.id, label: group.name })), role === 'ALLOCATION_MODERATOR')}
              <p className="field-help">Group is optional for most roles. Moderators need an active group. Supervisor and Manager coverage is managed separately on the Groups tab.</p>
              {selectMore('groups', canLoadMoreGroups, onLoadMoreGroups)}
            </div>
          </>
        )}

        {editor.collection === 'groups' && (
          <>
            {registerField('name', 'Name', 'text', true)}
            {renderSelect('supervisorId', 'Supervisor', supervisors.map((person) => ({ id: person.id, label: person.displayName })), false, true)}
            {selectMore('people', canLoadMorePeople, onLoadMorePeople)}
            {renderSelect('managerId', 'Manager', managers.map((person) => ({ id: person.id, label: person.displayName })), false, true)}
            <p className="field-help full-row">Active groups need an active Supervisor and Manager. Only active people with the matching role are selectable.</p>
          </>
        )}

        {editor.collection === 'resource-profiles' && (
          <>
            {registerField('name', 'Name', 'text', true)}
            {renderSelect('groupId', 'Group', groupOptions.map((group) => ({ id: group.id, label: group.name })), true)}
            {selectMore('groups', canLoadMoreGroups, onLoadMoreGroups)}
          </>
        )}

        {editor.collection === 'initiatives' && (
          <>
            <label className="form-field" htmlFor="admin-code">
              <span>Code <span aria-hidden="true">*</span></span>
              <input id="admin-code" maxLength={100} aria-invalid={Boolean(formState.errors.code)} aria-describedby={formState.errors.code ? 'admin-code-error' : 'admin-code-help'} {...register('code', { required: 'Enter a code.', maxLength: { value: 100, message: 'Code must be 100 characters or fewer.' } })} />
              {formState.errors.code?.message
                ? <span id="admin-code-error" className="field-error">{formState.errors.code.message}</span>
                : <span id="admin-code-help" className="field-help">Codes are unique after trimming and ignoring letter case.</span>}
            </label>
            <label className="form-field" htmlFor="admin-name">
              <span>Name <span aria-hidden="true">*</span></span>
              <input id="admin-name" maxLength={200} aria-invalid={Boolean(formState.errors.name)} aria-describedby={formState.errors.name ? 'admin-name-error' : undefined} {...register('name', { required: 'Enter a name.', maxLength: { value: 200, message: 'Name must be 200 characters or fewer.' } })} />
              {formState.errors.name?.message && <span id="admin-name-error" className="field-error">{formState.errors.name.message}</span>}
            </label>
          </>
        )}

        <label className="check-field" htmlFor="admin-active">
          <input id="admin-active" type="checkbox" {...register('active')} />
          <span>Active</span>
        </label>

        <div className="form-actions">
          <button className="secondary-button" type="button" onClick={onClose} disabled={mutation.isPending}>Cancel</button>
          <button className="primary-button" type="submit" disabled={mutation.isPending || (editor.mode === 'edit' && !detail?.etag)}>
            {mutation.isPending ? 'Saving…' : `Save ${collectionSingularLabels[editor.collection]}`}
          </button>
        </div>
      </form>
    </section>
  );
}

export { Administration };
