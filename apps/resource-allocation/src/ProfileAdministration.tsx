import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import {
  AdministrationRequestError,
  createAdminResource,
  getAdminCollection,
  getAdminResource,
  updateAdminResource,
  type AdminResourceProfile,
  type AdminResourceResponse,
  type ResourceAllocationRole,
} from './administrationApi';
import { ALLOCATIONS_QUERY_ROOT } from './allocationApi';
import { NOTIFICATIONS_QUERY_ROOT } from './notificationsApi';
import { REQUESTS_QUERY_ROOT } from './requestApi';
import { REQUEST_QUEUES_QUERY_ROOT } from './requestQueueApi';
import { SELECTIONS_QUERY_ROOT, SUBMISSIONS_QUERY_ROOT } from './submissionApi';
import { useNavigationFormProtection, useNavigationProtection } from './NavigationProtection';
import { getManageableProfileGroups } from './resource-profile-administration-api';

interface ProfileAdministrationProps {
  localUserId: string;
  role: ResourceAllocationRole;
  onAccessDenied: () => void;
}

interface ProfileFormValues {
  name: string;
  groupId: string;
  active: boolean;
}

type ProfileEditor = { mode: 'create' } | { mode: 'edit'; id: string };

const defaultValues: ProfileFormValues = { name: '', groupId: '', active: true };

function profileQueryKey(localUserId: string) {
  return ['resource-allocation-profile-administration', localUserId] as const;
}

function getRows<T>(data: { pages: Array<{ items: T[] }> } | undefined): T[] {
  return data?.pages.flatMap((page) => page.items) ?? [];
}

function isAccessDenied(error: unknown): boolean {
  return error instanceof AdministrationRequestError && (error.status === 401 || error.status === 403);
}

function errorMessage(error: unknown): string {
  if (error instanceof AdministrationRequestError) {
    if (error.status === 412) return 'This profile changed after you opened it. Your edits are still here. Close the form and reopen the profile to review the latest version.';
    return error.message;
  }
  return 'The resource profile service is temporarily unavailable. Try again.';
}

function activeBadge(active: boolean) {
  return <span className={active ? 'status-badge status-badge-active' : 'status-badge'}>{active ? 'Active' : 'Inactive'}</span>;
}

export function ProfileAdministration({ localUserId, role, onAccessDenied }: ProfileAdministrationProps) {
  const queryClient = useQueryClient();
  const { guardNavigation } = useNavigationProtection();
  const [editor, setEditor] = useState<ProfileEditor | null>(null);
  const [notice, setNotice] = useState('');
  const profilesQuery = useInfiniteQuery({
    queryKey: [...profileQueryKey(localUserId), 'profiles'],
    queryFn: ({ pageParam }) => getAdminCollection('resource-profiles', localUserId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.page.nextCursor ?? undefined,
    retry: false,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  const groupsQuery = useInfiniteQuery({
    queryKey: [...profileQueryKey(localUserId), 'groups'],
    queryFn: ({ pageParam }) => getManageableProfileGroups(localUserId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.page.nextCursor ?? undefined,
    retry: false,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });

  const profiles = useMemo(() => getRows<AdminResourceProfile>(profilesQuery.data), [profilesQuery.data]);
  const groups = useMemo(() => getRows(groupsQuery.data), [groupsQuery.data]);
  const groupNameById = useMemo(() => new Map(groups.map((group) => [group.id, group.name])), [groups]);
  const accessFailure = (profilesQuery.isError && isAccessDenied(profilesQuery.error))
    || (groupsQuery.isError && isAccessDenied(groupsQuery.error));

  useEffect(() => {
    if (accessFailure) onAccessDenied();
  }, [accessFailure, onAccessDenied]);

  function openEditor(nextEditor: ProfileEditor) {
    guardNavigation(() => {
      setNotice('');
      setEditor(nextEditor);
    });
  }

  function closeEditor() {
    setEditor(null);
  }

  const hasProfileError = profilesQuery.isError && !profilesQuery.isFetchNextPageError;
  const hasGroupError = groupsQuery.isError && !groupsQuery.isFetchNextPageError;

  return (
    <section className="administration-card" aria-labelledby="profile-administration-title">
      <div className="administration-heading">
        <div>
          <p className="eyebrow">Resource administration</p>
          <h2 id="profile-administration-title">Resource profiles</h2>
          <p className="supporting-copy">
            Manage profiles in your current {role === 'ALLOCATION_MODERATOR' ? 'group' : 'group scope'}. Existing allocations and capacity remain unchanged when a profile is deactivated.
          </p>
        </div>
      </div>

      <section className="admin-record-panel" aria-labelledby="managed-profile-list-title">
        <div className="admin-panel-heading">
          <div>
            <h3 id="managed-profile-list-title">Resource profiles</h3>
            <p>Inactive profiles remain visible in existing records and are unavailable for new selections.</p>
          </div>
          <button
            className="primary-button"
            type="button"
            onClick={() => openEditor({ mode: 'create' })}
            disabled={groupsQuery.isPending || groups.length === 0 || groupsQuery.isError}
          >
            Add resource profile
          </button>
        </div>

        {notice && <p className="inline-success" role="status">{notice}</p>}

        {hasGroupError && (
          <div className="form-error" role="alert">
            <p>Current group scope could not be loaded. No profile changes are available.</p>
            <button className="text-button" type="button" onClick={() => void groupsQuery.refetch()} disabled={groupsQuery.isFetching}>Try again</button>
          </div>
        )}
        {groupsQuery.isPending && <p className="supporting-copy" role="status">Checking your profile groups…</p>}
        {!groupsQuery.isPending && !groupsQuery.isError && groups.length === 0 && (
          <p className="empty-state">No active groups are assigned to your profile-management scope.</p>
        )}

        {hasProfileError && (
          <div className="form-error" role="alert">
            <p>Resource profiles could not be loaded. Your saved work is unchanged.</p>
            <button className="text-button" type="button" onClick={() => void profilesQuery.refetch()} disabled={profilesQuery.isFetching}>Try again</button>
          </div>
        )}
        {profilesQuery.isPending && <p className="supporting-copy" role="status">Loading resource profiles…</p>}
        {!profilesQuery.isPending && profiles.length === 0 && !profilesQuery.isError && groups.length > 0 && (
          <p className="empty-state">No resource profiles have been added to your current group scope.</p>
        )}

        {profiles.length > 0 && (
          <div className="table-scroll">
            <table className="admin-table">
              <caption className="sr-only">Resource profiles in your current group scope</caption>
              <thead>
                <tr><th scope="col">Resource profile</th><th scope="col">Group</th><th scope="col">Status</th><th scope="col">Actions</th></tr>
              </thead>
              <tbody>
                {profiles.map((profile) => (
                  <tr key={profile.id}>
                    <td><strong>{profile.name}</strong></td>
                    <td>{groupNameById.get(profile.groupId) ?? 'Group unavailable'}</td>
                    <td>{activeBadge(profile.active)}</td>
                    <td>
                      <button
                        className="text-button"
                        type="button"
                        aria-label={`Edit resource profile ${profile.name}`}
                        onClick={() => openEditor({ mode: 'edit', id: profile.id })}
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {(profilesQuery.hasNextPage || profilesQuery.isFetchNextPageError) && (
          <div className="load-more-row">
            {profilesQuery.isFetchNextPageError && <p className="form-error" role="alert">More profiles could not be loaded. The profiles already shown are still available.</p>}
            <button
              className="secondary-button"
              type="button"
              disabled={profilesQuery.isFetching || (profilesQuery.isError && !profilesQuery.isFetchNextPageError)}
              onClick={() => void profilesQuery.fetchNextPage()}
            >
              {profilesQuery.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}

        {(groupsQuery.hasNextPage || groupsQuery.isFetchNextPageError) && (
          <div className="load-more-row">
            {groupsQuery.isFetchNextPageError && <p className="form-error" role="alert">More scoped groups could not be loaded. The groups already shown are still available.</p>}
            <button
              className="secondary-button"
              type="button"
              disabled={groupsQuery.isFetching || (groupsQuery.isError && !groupsQuery.isFetchNextPageError)}
              onClick={() => void groupsQuery.fetchNextPage()}
            >
              {groupsQuery.isFetchingNextPage ? 'Loading…' : 'Load more groups'}
            </button>
          </div>
        )}
      </section>

      {editor && (
        <ResourceProfileEditor
          key={`${editor.mode}:${editor.mode === 'edit' ? editor.id : 'new'}`}
          editor={editor}
          role={role}
          groups={groups}
          localUserId={localUserId}
          onAccessDenied={onAccessDenied}
          onClose={closeEditor}
          onSaved={async (mode) => {
            await Promise.all([
              queryClient.resetQueries({ queryKey: profileQueryKey(localUserId) }),
              queryClient.invalidateQueries({ queryKey: [...SELECTIONS_QUERY_ROOT, localUserId] }),
              queryClient.invalidateQueries({ queryKey: REQUESTS_QUERY_ROOT }),
              queryClient.invalidateQueries({ queryKey: REQUEST_QUEUES_QUERY_ROOT }),
              queryClient.invalidateQueries({ queryKey: ALLOCATIONS_QUERY_ROOT }),
              queryClient.invalidateQueries({ queryKey: SUBMISSIONS_QUERY_ROOT }),
              queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_ROOT }),
            ]);
            setEditor(null);
            setNotice(`Resource profile ${mode === 'create' ? 'created' : 'updated'}.`);
          }}
        />
      )}
    </section>
  );
}

function ResourceProfileEditor({
  editor,
  role,
  groups,
  localUserId,
  onAccessDenied,
  onClose,
  onSaved,
}: {
  editor: ProfileEditor;
  role: ResourceAllocationRole;
  groups: Array<{ id: string; name: string }>;
  localUserId: string;
  onAccessDenied: () => void;
  onClose: () => void;
  onSaved: (mode: ProfileEditor['mode']) => Promise<void>;
}) {
  const editId = editor.mode === 'edit' ? editor.id : undefined;
  const detailQuery = useQuery<AdminResourceResponse<AdminResourceProfile>>({
    queryKey: [...profileQueryKey(localUserId), 'detail', editId],
    queryFn: () => getAdminResource('resource-profiles', editId!, localUserId),
    enabled: Boolean(editId),
    refetchOnWindowFocus: true,
    staleTime: 0,
    retry: false,
  });

  useEffect(() => {
    if (detailQuery.isError && isAccessDenied(detailQuery.error)) onAccessDenied();
  }, [detailQuery.error, detailQuery.isError, onAccessDenied]);

  if (editId && detailQuery.isError && (!detailQuery.data || !detailQuery.isFetchedAfterMount)) {
    return (
      <div className="editor-panel" role="alert">
        <p>{errorMessage(detailQuery.error)}</p>
        <button type="button" className="secondary-button" onClick={onClose}>Close</button>
      </div>
    );
  }
  if (editId && (detailQuery.isPending || !detailQuery.isFetchedAfterMount || !detailQuery.data)) {
    return <div className="editor-panel" role="status">Loading resource profile…</div>;
  }

  return (
    <ResourceProfileEditorForm
      editor={editor}
      role={role}
      groups={groups}
      localUserId={localUserId}
      onAccessDenied={onAccessDenied}
      onClose={onClose}
      onSaved={onSaved}
      initialProfile={editId ? detailQuery.data?.record : undefined}
      originalEtag={editId ? detailQuery.data?.etag ?? '' : ''}
      detailRefreshError={Boolean(editId && detailQuery.isError)}
    />
  );
}

function ResourceProfileEditorForm({
  editor,
  role,
  groups,
  localUserId,
  onAccessDenied,
  onClose,
  onSaved,
  initialProfile,
  originalEtag,
  detailRefreshError,
}: {
  editor: ProfileEditor;
  role: ResourceAllocationRole;
  groups: Array<{ id: string; name: string }>;
  localUserId: string;
  onAccessDenied: () => void;
  onClose: () => void;
  onSaved: (mode: ProfileEditor['mode']) => Promise<void>;
  initialProfile?: AdminResourceProfile;
  originalEtag: string;
  detailRefreshError: boolean;
}) {
  const editId = editor.mode === 'edit' ? editor.id : undefined;
  const { register, handleSubmit, setValue, control, formState } = useForm<ProfileFormValues>({
    defaultValues: initialProfile ? {
      name: initialProfile.name,
      groupId: initialProfile.groupId,
      active: initialProfile.active,
    } : defaultValues,
  });
  const originalEtagSnapshot = useRef(originalEtag);
  const guardEditorClose = useNavigationFormProtection('resource profile editor', formState.isDirty, formState.isSubmitting);
  const active = useWatch({ control, name: 'active' });
  const [submissionError, setSubmissionError] = useState('');
  const idempotencyKeys = useRef(new Map<string, string>());
  const canChangeActive = role === 'ALLOCATION_ADMIN' || editor.mode === 'create' || initialProfile?.active !== false;

  useEffect(() => {
    if (!editId && groups.length === 1 && !formState.isDirty) {
      setValue('groupId', groups[0].id, { shouldDirty: false });
    }
  }, [editId, formState.isDirty, groups, setValue]);

  const mutation = useMutation({
    mutationFn: async (values: ProfileFormValues) => {
      const payload = { name: values.name.trim(), groupId: values.groupId, active: values.active };
      if (editor.mode === 'create') {
        const fingerprint = JSON.stringify(payload);
        let idempotencyKey = idempotencyKeys.current.get(fingerprint);
        if (!idempotencyKey) {
          idempotencyKey = crypto.randomUUID();
          idempotencyKeys.current.set(fingerprint, idempotencyKey);
        }
        return createAdminResource('resource-profiles', localUserId, payload, idempotencyKey);
      }
      return updateAdminResource('resource-profiles', editId!, localUserId, originalEtagSnapshot.current, payload);
    },
    onSuccess: async () => onSaved(editor.mode),
    onError: (error) => {
      setSubmissionError(errorMessage(error));
      if (isAccessDenied(error)) onAccessDenied();
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    setSubmissionError('');
    try {
      await mutation.mutateAsync(values);
    } catch {
      // The mutation's onError displays the failure beside this form.
    }
  });

  const close = () => guardEditorClose(onClose);
  const editorHeading = `${editor.mode === 'create' ? 'Add' : 'Edit'} resource profile`;

  return (
    <section className="editor-panel" aria-labelledby="resource-profile-editor-title">
      <div className="editor-heading">
        <div>
          <h3 id="resource-profile-editor-title">{editorHeading}</h3>
          <p>Only profile name, group, and active status are available here.</p>
        </div>
        <button className="icon-button" type="button" onClick={close}>Close form</button>
      </div>

      {editId && detailRefreshError && (
        <p className="form-error" role="alert">The latest profile version could not be checked. Your current values are still here. Close and reopen the profile to try again.</p>
      )}
      {submissionError && <p className="form-error" role="alert">{submissionError}</p>}
      <form className="admin-form" onSubmit={(event) => void onSubmit(event)} noValidate>
        <label className="form-field full-row">
          <span>Resource profile name</span>
          <input
            autoFocus
            aria-invalid={Boolean(formState.errors.name)}
            {...register('name', { required: 'Enter a resource profile name.', validate: (value) => Boolean(value.trim()) || 'Enter a resource profile name.' })}
          />
          {formState.errors.name?.message && <span className="field-error">{formState.errors.name.message}</span>}
        </label>

        <label className="form-field full-row">
          <span>Group</span>
          <select
            aria-invalid={Boolean(formState.errors.groupId)}
            {...register('groupId', { required: 'Choose a group in your current scope.' })}
          >
            <option value="">Select a group</option>
            {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
          {formState.errors.groupId?.message && <span className="field-error">{formState.errors.groupId.message}</span>}
        </label>

        <div className="field-with-help full-row">
          <label className="check-field">
            <input type="checkbox" disabled={!canChangeActive} {...register('active')} />
            Active
          </label>
          <p className="field-help">Existing allocations and capacity remain unchanged when a profile is deactivated. Inactive profiles are unavailable for new selections.</p>
        </div>
        {!canChangeActive && <p className="field-help full-row">Only an Admin can reactivate an inactive resource profile.</p>}
        {!active && editor.mode === 'edit' && (
          <p className="field-help full-row">After saving, this profile will be unavailable for new selections. Existing allocations and capacity remain available.</p>
        )}

        <div className="form-actions">
          <button className="secondary-button" type="button" onClick={close}>Cancel</button>
          <button className="primary-button" type="submit" disabled={mutation.isPending || groups.length === 0}>
            {mutation.isPending ? 'Saving…' : 'Save resource profile'}
          </button>
        </div>
      </form>
    </section>
  );
}
