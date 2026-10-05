-- 0025_publication_targets_status_index.sql
create index if not exists publication_targets_organization_status_idx
  on public.publication_targets (organization_id, status);
